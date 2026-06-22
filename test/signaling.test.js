import test from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  addConnection,
  handleMessage,
  removeConnection,
  stats,
} from "../src/signaling.js";

// Deterministic generators for predictable ids/codes in tests.
function newState() {
  let idN = 0;
  let codeN = 0;
  return createState({
    genId: () => `10000000${++idN}`,
    genCode: () => String(100000 + ++codeN),
    now: () => 1000,
  });
}

function sends(result) {
  return result.actions.filter((a) => a.kind === "send");
}
function findSend(result, to) {
  return sends(result).find((a) => a.to === to)?.message;
}

test("agent registers and receives id + code", () => {
  const s = newState();
  addConnection(s, "a1", "1.2.3.4");
  const r = handleMessage(s, "a1", { type: "register", role: "agent", name: "Pixel", platform: "android" });
  const reg = findSend(r, "a1");
  assert.equal(reg.type, "registered");
  assert.equal(reg.deviceId, "100000001");
  assert.equal(reg.code, "100001");
  assert.equal(s.devices.size, 1);
  assert.equal(s.devices.get("100000001").connId, "a1");
});

test("agent re-registers with existing deviceId and keeps its code", () => {
  const s = newState();
  addConnection(s, "a1");
  handleMessage(s, "a1", { type: "register", role: "agent", name: "P" });
  const code = s.devices.get("100000001").code;
  // Reconnect on a new connection, presenting the known deviceId.
  addConnection(s, "a2");
  const r = handleMessage(s, "a2", { type: "register", role: "agent", deviceId: "100000001", name: "P" });
  const reg = findSend(r, "a2");
  assert.equal(reg.deviceId, "100000001");
  assert.equal(reg.code, code);
  assert.equal(s.devices.get("100000001").connId, "a2");
});

test("controller connects with correct code", () => {
  const s = newState();
  addConnection(s, "a1", "10.0.0.1");
  handleMessage(s, "a1", { type: "register", role: "agent", name: "P" });
  const code = s.devices.get("100000001").code;

  addConnection(s, "c1", "20.0.0.2");
  const r = handleMessage(s, "c1", { type: "connect", role: "controller", targetId: "100000001", code });

  const toController = findSend(r, "c1");
  const toAgent = findSend(r, "a1");
  assert.equal(toController.type, "connected");
  assert.equal(toController.device.deviceId, "100000001");
  assert.equal(toAgent.type, "peer-join");
  assert.equal(toController.sessionId, toAgent.sessionId);
  assert.equal(s.sessions.size, 1);
});

test("controller with wrong code is rejected", () => {
  const s = newState();
  addConnection(s, "a1");
  handleMessage(s, "a1", { type: "register", role: "agent" });
  addConnection(s, "c1");
  const r = handleMessage(s, "c1", { type: "connect", targetId: "100000001", code: "000000" });
  assert.equal(findSend(r, "c1").code, "bad_code");
  assert.equal(s.sessions.size, 0);
});

test("connect to unknown device returns not_found", () => {
  const s = newState();
  addConnection(s, "c1");
  const r = handleMessage(s, "c1", { type: "connect", targetId: "999999999", code: "1" });
  assert.equal(findSend(r, "c1").code, "not_found");
});

test("connect to offline device returns not_found", () => {
  const s = newState();
  addConnection(s, "a1");
  handleMessage(s, "a1", { type: "register", role: "agent" });
  const code = s.devices.get("100000001").code;
  removeConnection(s, "a1"); // agent goes offline but record remains
  addConnection(s, "c1");
  const r = handleMessage(s, "c1", { type: "connect", targetId: "100000001", code });
  assert.equal(findSend(r, "c1").code, "not_found");
});

function establishSession(s) {
  addConnection(s, "a1");
  handleMessage(s, "a1", { type: "register", role: "agent" });
  const code = s.devices.get("100000001").code;
  addConnection(s, "c1");
  const r = handleMessage(s, "c1", { type: "connect", targetId: "100000001", code });
  return findSend(r, "c1").sessionId;
}

test("signal is relayed to the other peer only", () => {
  const s = newState();
  const sessionId = establishSession(s);
  const offer = { sdp: "v=0...", type: "offer" };
  const r = handleMessage(s, "c1", { type: "signal", sessionId, data: offer });
  const out = sends(r);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, "a1");
  assert.deepEqual(out[0].message.data, offer);

  // And back from agent to controller.
  const r2 = handleMessage(s, "a1", { type: "signal", sessionId, data: { type: "answer" } });
  assert.equal(sends(r2)[0].to, "c1");
});

test("signal on unknown session errors", () => {
  const s = newState();
  addConnection(s, "c1");
  const r = handleMessage(s, "c1", { type: "signal", sessionId: "nope", data: {} });
  assert.equal(findSend(r, "c1").code, "no_session");
});

test("hangup ends session and notifies the peer", () => {
  const s = newState();
  const sessionId = establishSession(s);
  const r = handleMessage(s, "c1", { type: "hangup", sessionId });
  assert.equal(findSend(r, "a1").type, "session-end");
  assert.equal(s.sessions.size, 0);
});

test("agent disconnect ends session and marks device offline", () => {
  const s = newState();
  const sessionId = establishSession(s);
  const r = removeConnection(s, "a1");
  // Controller is notified the session ended.
  assert.equal(findSend(r, "c1").type, "session-end");
  assert.equal(s.sessions.size, 0);
  // Device record persists but is offline.
  assert.equal(s.devices.get("100000001").connId, null);
});

test("ping returns pong", () => {
  const s = newState();
  addConnection(s, "x");
  const r = handleMessage(s, "x", { type: "ping" });
  assert.equal(findSend(r, "x").type, "pong");
});

test("malformed and unknown messages are handled safely", () => {
  const s = newState();
  addConnection(s, "x");
  assert.equal(findSend(handleMessage(s, "x", null), "x").code, "bad_message");
  assert.equal(findSend(handleMessage(s, "x", { type: "florp" }), "x").code, "unknown_type");
});

test("stats reflect live state", () => {
  const s = newState();
  establishSession(s);
  const st = stats(s);
  assert.equal(st.connections, 2);
  assert.equal(st.devices, 1);
  assert.equal(st.devicesOnline, 1);
  assert.equal(st.sessions, 1);
});
