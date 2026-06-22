// Environment-driven configuration for the signaling server.

function parseList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Builds the ICE server list handed to clients. STUN is always available via
 * public servers (configurable). TURN is included only when credentials are
 * supplied via env — typically pointing at the coturn instance on your VPS.
 */
export function getIceServers(env = process.env) {
  const stunUrls = parseList(env.STUN_URLS) .length
    ? parseList(env.STUN_URLS)
    : ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

  const iceServers = [{ urls: stunUrls }];

  const turnUrls = parseList(env.TURN_URLS);
  if (turnUrls.length && env.TURN_USERNAME && env.TURN_PASSWORD) {
    iceServers.push({
      urls: turnUrls,
      username: env.TURN_USERNAME,
      credential: env.TURN_PASSWORD,
    });
  }
  return iceServers;
}

export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    host: env.HOST || "0.0.0.0",
    nodeEnv: env.NODE_ENV || "development",
    // Drop connections that miss heartbeats for this long (ms).
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS) || 30000,
    iceServers: getIceServers(env),
  };
}
