// Orbit Remote — signaling core.
//
// Pure, transport-agnostic state machine for WebRTC signalling plus an anonymous
// "bridge chat" relay (PC <-> phone text, used to work around Android clipboard
// limits). It knows nothing about WebSockets: it takes a connection id + an
// incoming message and returns a list of *actions* (messages to send, logs to
// write). This keeps the protocol fully unit-testable without a network stack.

import { randomInt, randomUUID } from "node:crypto";

const DEVICE_ID_LENGTH = 9; // AnyDesk-style numeric id
const CODE_LENGTH = 6;

// --- Bridge chat limits (anonymous PC<->phone text relay) ---------------
const CHAT_MAX_MESSAGES = 100;       // kept per room (oldest dropped)
const CHAT_MAX_ROOMS = 1000;         // global cap
const CHAT_MAX_ROOMS_PER_CONN = 8;
const CHAT_TEXT_MAX = 4000;
const CHAT_FROM_MAX = 24;
const CHAT_RATE_MAX = 20;            // messages per window, per connection
const CHAT_RATE_WINDOW = 10_000;     // ms
const CHAT_ROOM_RE = /^[A-Za-z0-9]{4,32}$/;

// Strip control characters but keep tab (9), newline (10) and carriage return (13).
function stripControl(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) out += s[i];
  }
  return out;
}

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
 * @param {() => string} [opts.genId]    device id generator (injectable for tests)
 * @param {() => string} [opts.genCode]  code generator (injectable for tests)
 * @param {() => string} [opts.genMsgId] chat message id generator (injectable)
 * @param {() => number} [opts.now]      clock (ms), injectable for tests
 */
export function createState(opts = {}) {
  return {
    genId: opts.genId || (() => defaultGenId()),
    genCode: opts.genCode || (() => defaultGenCode()),
    genMsgId: opts.genMsgId || (() => randomUUID()),
    now: opts.now || (() => Date.now()),
    connections: new Map(), // connId -> { connId, ip, role, deviceId, sessionIds:Set, rooms:Set }
    devices: new Map(),     // deviceId -> { deviceId, name, platform, code, connId, registeredAt, lastSeen }
    sessions: new Map(),    // sessionId -> { sessionId, controllerConnId, agentConnId, agentDeviceId, startedAt }
    chatRooms: new Map(),   // room -> { members:Set<connId>, messages:[{id,seq,text,from,ts}], seq }
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
    rooms: new Set(),
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
      // Honor the agent's proposed (device-derived) code for a new registration so
      // the code stays stable across server restarts; reuse the stored one if the
      // device already exists; otherwise mint a fresh random code.
      const proposedCode = typeof msg.code === "string" && /^[0-9]{6}$/.test(msg.code)
        ? msg.code
        : null;
      const code = existing && existing.code
        ? existing.code
        : (proposedCode || state.genCode());

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
        authFails: existing ? existing.authFails || 0 : 0,
        lockedUntil: existing ? existing.lockedUntil || 0 : 0,
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

    // ---- Bridge chat -----------------------------------------------------

    case "chat-join": {
      const room = msg.room;
      if (typeof room !== "string" || !CHAT_ROOM_RE.test(room)) {
        return { actions: [send(connId, { type: "error", code: "bad_room" })] };
      }
      let chat = state.chatRooms.get(room);
      if (!chat) {
        if (state.chatRooms.size >= CHAT_MAX_ROOMS) {
          return { actions: [send(connId, { type: "error", code: "too_many_rooms" })] };
        }
        chat = { members: new Set(), messages: [], seq: 0 };
        state.chatRooms.set(room, chat);
      }
      if (!conn.rooms.has(room) && conn.rooms.size >= CHAT_MAX_ROOMS_PER_CONN) {
        return { actions: [send(connId, { type: "error", code: "too_many_rooms" })] };
      }
      chat.members.add(connId);
      conn.rooms.add(room);
      return { actions: [send(connId, { type: "chat-history", room, messages: chat.messages })] };
    }

    case "chat-send": {
      const room = msg.room;
      if (typeof room !== "string" || !conn.rooms.has(room)) {
        return { actions: [send(connId, { type: "error", code: "not_in_room" })] };
      }
      const chat = state.chatRooms.get(room);
      if (!chat) {
        return { actions: [send(connId, { type: "error", code: "not_in_room" })] };
      }
      // Per-connection rate limit.
      const nowTs = state.now();
      if (!conn.chatWindowStart || nowTs - conn.chatWindowStart >= CHAT_RATE_WINDOW) {
        conn.chatWindowStart = nowTs;
        conn.chatCount = 0;
      }
      conn.chatCount = (conn.chatCount || 0) + 1;
      if (conn.chatCount > CHAT_RATE_MAX) {
        return { actions: [send(connId, { type: "error", code: "rate_limited" })] };
      }
      let text = typeof msg.text === "string" ? stripControl(msg.text) : "";
      text = text.replace(/[ \t\r\n]+$/g, ""); // trim trailing whitespace
      if (text.length === 0 || text.length > CHAT_TEXT_MAX) {
        return { actions: [send(connId, { type: "error", code: "bad_text" })] };
      }
      const from = typeof msg.from === "string"
        ? stripControl(msg.from).trim().slice(0, CHAT_FROM_MAX)
        : "";
      const message = { id: state.genMsgId(), seq: ++chat.seq, text, from, ts: nowTs };
      chat.messages.push(message);
      if (chat.messages.length > CHAT_MAX_MESSAGES) chat.messages.shift();
      const actions = [];
      for (const cid of chat.members) {
        actions.push(send(cid, { type: "chat-msg", room, message }));
      }
      return { actions };
    }

    case "chat-leave": {
      const room = msg.room;
      if (typeof room === "string" && conn.rooms.has(room)) {
        conn.rooms.delete(room);
        const chat = state.chatRooms.get(room);
        if (chat) {
          chat.members.delete(connId);
          if (chat.members.size === 0) state.chatRooms.delete(room);
        }
      }
      return { actions: [] };
    }

    default:
      return { actions: [send(connId, { type: "error", code: "unknown_type", received: msg.type })] };
  }
}

/** Clean up a dropped connection: end its sessions, free its device, leave rooms. */
export function removeConnection(state, connId) {
  const conn = state.connections.get(connId);
  if (!conn) return { actions: [] };
  const actions = [];

  for (const sessionId of Array.from(conn.sessionIds)) {
    actions.push(...endSession(state, sessionId, "peer_disconnect", connId));
  }

  for (const room of conn.rooms) {
    const chat = state.chatRooms.get(room);
    if (chat) {
      chat.members.delete(connId);
      if (chat.members.size === 0) state.chatRooms.delete(room);
    }
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
 * Evict offline device registrations older than ttl and empty chat rooms so the
 * maps can't grow without bound (memory/DoS protection). Returns count removed.
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
  for (const [room, chat] of state.chatRooms) {
    if (chat.members.size === 0) {
      state.chatRooms.delete(room);
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
    chatRooms: state.chatRooms.size,
  };
}

export const _internals = { defaultGenId, defaultGenCode, DEVICE_ID_LENGTH, CODE_LENGTH };
