// Orbit Remote — signaling core.
//
// Pure, transport-agnostic state machine for WebRTC signalling. It knows nothing
// about WebSockets: it takes a connection id + an incoming message and returns a
// list of *actions* (messages to send, logs to write). This keeps the protocol
// fully unit-testable without a network stack.
//
// Roles:
//   - "agent"      : an Android device that registers itself and waits for control
//   - "controller" : a desktop client that connects to an agent by device id + code
//
// Connection codes provide first-line authorisation: the agent owns a code and a
// controller must present the matching code to establish a session. Trusted-device
// whitelisting and first-connection confirmation are enforced on the agent side;
// the server enforces existence, online status and code match.

import { randomInt } from "node:crypto";

const DEVICE_ID_LENGTH = 9; // AnyDesk-style numeric id
const CODE_LENGTH = 6;

// CSPRNG-backed [0,1) source so device ids and connection codes are not
// predictable (Math.random is not cryptographically secure). Tests can still
// inject a deterministic rnd via the function parameter.
function secureRandom() {
  return randomInt(0, 1_000_000) / 1_000_000;
}

function defaultGenId(rnd = secureRandom) {
  let id = "";
  // First digit non-zero so the id always has full length.
  id += String(1 + Math.floor(rnd() * 9));
  for (let i = 1; i < DEVICE_ID_LENGTH; i++) {
    id += String(Math.floor(rnd() * 10));
  }
  return id;
}

function defaultGenCode(rnd = secureRandom) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += String(Math.floor(rnd() * 10));
  return code;
}

/**
 * Create a fresh signaling state.
 * @param {object} [opts]
 * @param {() => string} [opts.genId]   device id generator (injectable for tests)
 * @param {() => string} [opts.genCode] code generator (injectable for tests)
 * @param {() => number} [opts.now]     clock (ms), injectable for tests
 */
export function createState(opts = {}) {
  return {
    genId: opts.genId || (() => defaultGenId()),
    genCode: opts.genCode || (() => defaultGenCode()),
    now: opts.now || (() => Date.now()),
    connections: new Map(), // connId -> { connId, ip, role, deviceId, sessionIds:Set }
    devices: new Map(), // deviceId -> { deviceId, name, platform, code, connId, registeredAt, lastSeen }
    sessions: new Map(), // sessionId -> { sessionId, controllerConnId, agentConnId, agentDeviceId, startedAt }
    sessionSeq: 0,
  };
}

export function addConnection(state, connId, ip) {
  state.connections.set(connId, {
    connId,
    ip: ip || null,
    role: null,
    deviceId: null,
    sessionIds: new Set(),
  });
  return { actions: [] };
}

function send(to, message) {
  return { kind: "send", to, message };
}
function log(event, data) {
  return { kind: "log", event, data: data || {} };
}

function peerOf(session, connId) {
  if (session.controllerConnId === connId) return session.agentConnId;
  if (session.agentConnId === connId) return session.controllerConnId;
  return null;
}

function endSession(state, sessionId, reason, exceptConnId) {
  const session = state.sessions.get(sessionId);
  const actions = [];
  if (!session) return actions;
  const peers = [session.controllerConnId, session.agentConnId];
  for (const cid of peers) {
    const conn = state.connections.get(cid);
    if (conn) conn.sessionIds.delete(sessionId);
    if (cid && cid !== exceptConnId && conn) {
      actions.push(send(cid, { type: "session-end", sessionId, reason }));
    }
  }
  const duration = state.now() - session.startedAt;
  actions.push(
    log("session_end", {
      sessionId,
      agentDeviceId: session.agentDeviceId,
      reason,
      durationMs: duration,
    })
  );
  state.sessions.delete(sessionId);
  return actions;
}

/**
 * Handle an incoming, already-parsed message from a connection.
 * @returns {{actions: Array}}
 */
export function handleMessage(state, connId, msg) {
  const conn = state.connections.get(connId);
  if (!conn) return { actions: [] };
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    return { actions: [send(connId, { type: "error", code: "bad_message" })] };
  }

  switch (msg.type) {
    case "ping":
      return { actions: [send(connId, { type: "pong", ts: state.now() })] };

    case "register": {
      const name = typeof msg.name === "string" ? msg.name.slice(0, 120) : "Unknown device";
      const platform = typeof msg.platform === "string" ? msg.platform.slice(0, 60) : "android";

      // Reuse an existing device id when the agent reconnects, otherwise mint one.
      let deviceId = typeof msg.deviceId === "string" && /^[0-9]{6,12}$/.test(msg.deviceId)
        ? msg.deviceId
        : null;
      if (!deviceId) {
        do {
          deviceId = state.genId();
        } while (state.devices.has(deviceId));
      }

      const existing = state.devices.get(deviceId);
      const code = existing && existing.code ? existing.code : state.genCode();

      // If another live connection held this device, detach it.
      if (existing && existing.connId && existing.connId !== connId) {
        const prev = state.connections.get(existing.connId);
        if (prev) prev.deviceId = null;
      }

      conn.role = "agent";
      conn.deviceId = deviceId;
      state.devices.set(deviceId, {
        deviceId,
        name,
        platform,
        code,
        connId,
        registeredAt: existing ? existing.registeredAt : state.now(),
        lastSeen: state.now(),
      });

      return {
        actions: [
          send(connId, { type: "registered", deviceId, code }),
          log("register", { deviceId, platform, ip: conn.ip }),
        ],
      };
    }

    case "connect": {
      if (typeof msg.targetId !== "string") {
        return { actions: [send(connId, { type: "error", code: "bad_target" })] };
      }
      const device = state.devices.get(msg.targetId);
      if (!device || !device.connId || !state.connections.has(device.connId)) {
        return { actions: [send(connId, { type: "error", code: "not_found", targetId: msg.targetId })] };
      }
      // Brute-force protection: lock a device for 60s after 5 wrong codes.
      const nowMs = state.now();
      if (device.lockedUntil && nowMs < device.lockedUntil) {
        return {
          actions: [
            send(connId, { type: "error", code: "locked", targetId: msg.targetId }),
            log("auth_locked", { targetId: msg.targetId, ip: conn.ip }),
          ],
        };
      }
      if (String(msg.code || "") !== String(device.code)) {
        device.authFails = (device.authFails || 0) + 1;
        if (device.authFails >= 5) device.lockedUntil = nowMs + 60_000;
        return {
          actions: [
            send(connId, { type: "error", code: "bad_code", targetId: msg.targetId }),
            log("auth_fail", { targetId: msg.targetId, ip: conn.ip, fails: device.authFails }),
          ],
        };
      }
      device.authFails = 0;
      device.lockedUntil = 0;

      const sessionId = `s${++state.sessionSeq}`;
      const session = {
        sessionId,
        controllerConnId: connId,
        agentConnId: device.connId,
        agentDeviceId: device.deviceId,
        startedAt: state.now(),
      };
      state.sessions.set(sessionId, session);
      conn.role = "controller";
      conn.sessionIds.add(sessionId);
      const agentConn = state.connections.get(device.connId);
      agentConn.sessionIds.add(sessionId);

      return {
        actions: [
          // Tell the agent a controller wants in; the agent confirms/whitelists locally.
          send(device.connId, {
            type: "peer-join",
            sessionId,
            role: "controller",
            from: { ip: conn.ip },
          }),
          send(connId, {
            type: "connected",
            sessionId,
            device: { deviceId: device.deviceId, name: device.name, platform: device.platform },
          }),
          log("session_start", {
            sessionId,
            agentDeviceId: device.deviceId,
            controllerIp: conn.ip,
          }),
        ],
      };
    }

    case "signal": {
      // Relay opaque SDP / ICE payloads to the other peer of the session.
      const session = state.sessions.get(msg.sessionId);
      if (!session) {
        return { actions: [send(connId, { type: "error", code: "no_session", sessionId: msg.sessionId })] };
      }
      const peer = peerOf(session, connId);
      if (!peer) {
        return { actions: [send(connId, { type: "error", code: "not_in_session", sessionId: msg.sessionId })] };
      }
      return {
        actions: [send(peer, { type: "signal", sessionId: msg.sessionId, data: msg.data })],
      };
    }

    case "hangup": {
      return { actions: endSession(state, msg.sessionId, "hangup", connId) };
    }

    default:
      return { actions: [send(connId, { type: "error", code: "unknown_type", received: msg.type })] };
  }
}

/** Clean up a dropped connection: end its sessions and free its device. */
export function removeConnection(state, connId) {
  const conn = state.connections.get(connId);
  if (!conn) return { actions: [] };
  const actions = [];

  for (const sessionId of Array.from(conn.sessionIds)) {
    actions.push(...endSession(state, sessionId, "peer_disconnect", connId));
  }

  if (conn.deviceId) {
    const device = state.devices.get(conn.deviceId);
    if (device && device.connId === connId) {
      // Keep the registration record but mark it offline (connId cleared).
      device.connId = null;
      device.lastSeen = state.now();
      actions.push(log("agent_offline", { deviceId: conn.deviceId }));
    }
  }

  state.connections.delete(connId);
  return { actions };
}

/**
 * Evict offline device registrations older than ttl so the devices map can't grow
 * without bound (memory/DoS protection). Returns the number removed.
 */
export function sweep(state, ttlMs = 86_400_000) {
  const cutoff = state.now() - ttlMs;
  let removed = 0;
  for (const [id, d] of state.devices) {
    if (!d.connId && (d.lastSeen || 0) < cutoff) {
      state.devices.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Snapshot for diagnostics / health. */
export function stats(state) {
  let online = 0;
  for (const d of state.devices.values()) if (d.connId) online++;
  return {
    connections: state.connections.size,
    devices: state.devices.size,
    devicesOnline: online,
    sessions: state.sessions.size,
  };
}

export const _internals = { defaultGenId, defaultGenCode, DEVICE_ID_LENGTH, CODE_LENGTH };
