// Orbit Remote — signaling server transport.
//
// Thin WebSocket + HTTP layer around the pure signaling core in ./signaling.js.
//   - HTTP  GET /health        liveness + live stats
//   - HTTP  GET /ice-servers   ICE (STUN/TURN) configuration for clients
//   - WS    /ws                signalling channel for agents and controllers

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { getConfig } from "./config.js";
import {
  createState,
  addConnection,
  handleMessage,
  removeConnection,
  stats,
} from "./signaling.js";

const config = getConfig();
const state = createState();

// Map our internal connection ids to live WebSocket objects.
const sockets = new Map();

function logLine(event, data) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  // Structured single-line logs — easy to grep / ship to a log drain.
  console.log(JSON.stringify(entry));
}

function applyActions(actions) {
  for (const action of actions) {
    if (action.kind === "send") {
      const ws = sockets.get(action.to);
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(action.message));
      }
    } else if (action.kind === "log") {
      logLine(action.event, action.data);
    }
  }
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || null;
}

// ---- HTTP server -------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), ...stats(state) }));
  }

  if (req.url === "/ice-servers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ iceServers: config.iceServers }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// ---- WebSocket server --------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws, req) => {
  const connId = randomUUID();
  sockets.set(connId, ws);
  ws.isAlive = true;

  applyActions(addConnection(state, connId, clientIp(req)).actions);
  // Hand the ICE configuration to the client immediately on connect.
  ws.send(JSON.stringify({ type: "welcome", connId, iceServers: config.iceServers }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "invalid_json" }));
      return;
    }
    try {
      applyActions(handleMessage(state, connId, msg).actions);
    } catch (err) {
      logLine("handler_error", { connId, error: String(err && err.message) });
      ws.send(JSON.stringify({ type: "error", code: "internal" }));
    }
  });

  ws.on("close", () => {
    applyActions(removeConnection(state, connId).actions);
    sockets.delete(connId);
  });

  ws.on("error", () => {
    // 'close' will follow; cleanup happens there.
  });
});

// Heartbeat: terminate connections that stop responding to pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, config.heartbeatIntervalMs);

wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(config.port, config.host, () => {
  logLine("listening", { host: config.host, port: config.port, env: config.nodeEnv });
});

// Graceful shutdown.
function shutdown(signal) {
  logLine("shutdown", { signal });
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, "server shutdown");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
