const WebSocket = require("ws");
const readline = require("readline");

const args = process.argv.slice(2);

// Format: node ws_proxy.js <port> <url>
const LOCAL_PORT = args[0] && args[0] !== "null" ? Number(args[0]) : 6001;
const UPSTREAM_URL = args[1] && args[1] !== "null" ? args[1] : null;
const ERROR_STATUS_CODE = args[2] && Number(args[2]) > 0 ? Number(args[2]) : 500;
const ERROR_RESPONSE_MESSAGE =
  args[3] && String(args[3]).trim()
    ? String(args[3])
    : "Service unavailable (simulated)";
const MAX_MESSAGES_PER_SECOND =
  args[4] && Number(args[4]) > 0 ? Number(args[4]) : 3;
const MAX_CLOSE_REASON_LENGTH = 123;
const MAX_PENDING_MESSAGES = 100;

if (!UPSTREAM_URL) {
  console.error("Please provide an upstream websocket URL.");
  console.log("Example:");
  console.log("node ws_proxy.js 4001 wss://rpc.example.com/ws");
  process.exit(1);
}

console.log("Using PORT:", LOCAL_PORT);
console.log("Using Upstream URL:", UPSTREAM_URL);
console.log("Simulated status code:", ERROR_STATUS_CODE);
console.log("Simulated error message:", ERROR_RESPONSE_MESSAGE);
console.log("Max throughput (messages/sec):", MAX_MESSAGES_PER_SECOND);

let allowConnections = true;
const bridges = new Set();


/* ------------------------
   ACTIVITY HEARTBEAT
   The manager reads this line to know the proxy is still carrying traffic,
   and retires it when it goes quiet. Throttled so busy proxies stay quiet.
   ------------------------ */
const ACTIVITY_MARKER = "__simproxy_activity__";
const ACTIVITY_THROTTLE_MS = Number(process.env.SIMPROXY_ACTIVITY_PING_MS) > 0
  ? Number(process.env.SIMPROXY_ACTIVITY_PING_MS)
  : 10000;
let lastActivityMarkAt = 0;

function markActivity() {
  const now = Date.now();
  if (now - lastActivityMarkAt < ACTIVITY_THROTTLE_MS) return;
  lastActivityMarkAt = now;
  process.stdout.write(`${ACTIVITY_MARKER}\n`);
}

function normalizeCloseReason(reason, fallback = ERROR_RESPONSE_MESSAGE) {
  const text = String(reason || fallback || "Connection closed").trim();
  if (!text) return "Connection closed";
  return text.slice(0, MAX_CLOSE_REASON_LENGTH);
}

function normalizeCloseCode(code, fallback = 1011) {
  const normalized = Number(code);
  if (!Number.isInteger(normalized)) return fallback;
  if (normalized === 1000) return 1000;
  if (normalized >= 1001 && normalized <= 1014) {
    if ([1004, 1005, 1006].includes(normalized)) return fallback;
    return normalized;
  }
  if (normalized >= 3000 && normalized <= 4999) return normalized;
  return fallback;
}

function buildRateLimiter() {
  let windowStartMs = Date.now();
  let messageCountInWindow = 0;

  return function isRateLimited() {
    const now = Date.now();
    if (now - windowStartMs >= 1000) {
      windowStartMs = now;
      messageCountInWindow = 0;
    }
    messageCountInWindow += 1;
    return messageCountInWindow > MAX_MESSAGES_PER_SECOND;
  };
}

function extractForwardHeaders(req) {
  const headers = {};
  const allowedHeaders = [
    "authorization",
    "cookie",
    "origin",
    "user-agent",
    "x-forwarded-for",
    "x-real-ip",
  ];

  for (const headerName of allowedHeaders) {
    const headerValue = req.headers[headerName];
    if (headerValue !== undefined) headers[headerName] = headerValue;
  }

  return headers;
}

function createUpstreamSocket(req) {
  const protocols = req.headers["sec-websocket-protocol"]
    ? String(req.headers["sec-websocket-protocol"])
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const options = { headers: extractForwardHeaders(req) };

  return protocols.length
    ? new WebSocket(UPSTREAM_URL, protocols, options)
    : new WebSocket(UPSTREAM_URL, options);
}

function safeCloseSocket(socket, code, reason) {
  if (!socket) return;

  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }

  if (socket.readyState === WebSocket.OPEN) {
    socket.close(
      normalizeCloseCode(code),
      normalizeCloseReason(reason),
    );
  }
}

function createBridge(client, req) {
  const upstream = createUpstreamSocket(req);
  const isRateLimited = buildRateLimiter();
  const bridge = {
    client,
    upstream,
    pendingMessages: [],
    closed: false,
  };

  bridges.add(bridge);
  console.log(
    `Client connected (${req.socket.remoteAddress || "unknown"}) -> upstream ${UPSTREAM_URL}`,
  );

  function cleanup() {
    if (bridge.closed) return;
    bridge.closed = true;
    bridge.pendingMessages.length = 0;
    bridges.delete(bridge);
  }

  function flushPendingMessages() {
    if (bridge.closed || upstream.readyState !== WebSocket.OPEN) return;
    while (bridge.pendingMessages.length > 0) {
      const queued = bridge.pendingMessages.shift();
      if (!queued) continue;
      upstream.send(queued.payload, { binary: queued.isBinary });
    }
  }

  client.on("message", (payload, isBinary) => {
    if (bridge.closed) return;
    markActivity();

    if (isRateLimited()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            error: `Rate limit exceeded: max ${MAX_MESSAGES_PER_SECOND} messages/second`,
            code: 429,
          }),
        );
      }
      return;
    }

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload, { binary: isBinary });
      return;
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      if (bridge.pendingMessages.length >= MAX_PENDING_MESSAGES) {
        console.log("Dropping client: pending WS queue exceeded limit");
        safeCloseSocket(client, 1013, "Upstream websocket is not ready");
        safeCloseSocket(upstream, 1013, "Client queue overflow");
        cleanup();
        return;
      }

      bridge.pendingMessages.push({ payload, isBinary });
      return;
    }

    console.log("Cannot forward message: upstream socket is unavailable");
    safeCloseSocket(client, 1011, "Upstream websocket is unavailable");
    cleanup();
  });

  client.on("close", (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || "");
    console.log(`Client disconnected (code=${code || 1000}, reason=${reason || "none"})`);
    safeCloseSocket(upstream, 1000, "Client disconnected");
    cleanup();
  });

  client.on("error", (error) => {
    console.log(`Client socket error: ${error.message}`);
    safeCloseSocket(upstream, 1011, "Client websocket error");
    cleanup();
  });

  upstream.on("open", () => {
    console.log("Upstream websocket connected");
    flushPendingMessages();
  });

  upstream.on("message", (payload, isBinary) => {
    if (bridge.closed || client.readyState !== WebSocket.OPEN) return;
    markActivity();
    client.send(payload, { binary: isBinary });
  });

  upstream.on("close", (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || "");
    console.log(`Upstream websocket closed (code=${code || 1000}, reason=${reason || "none"})`);
    safeCloseSocket(client, code || 1011, reason || ERROR_RESPONSE_MESSAGE);
    cleanup();
  });

  upstream.on("error", (error) => {
    console.log(`Upstream websocket error: ${error.message}`);
    safeCloseSocket(client, 1011, ERROR_RESPONSE_MESSAGE);
    cleanup();
  });
}

const wss = new WebSocket.Server({ port: LOCAL_PORT });
console.log(`WS Proxy: ws://localhost:${LOCAL_PORT}`);
console.log("Commands: (b) break all | (f) fix | (q) quit\n");

wss.on("connection", (client, req) => {
  markActivity();

  if (!allowConnections) {
    console.log(`Incoming connection rejected (DOWN): ${ERROR_RESPONSE_MESSAGE}`);
    client.close(1013, normalizeCloseReason(ERROR_RESPONSE_MESSAGE));
    return;
  }

  createBridge(client, req);
});

wss.on("error", (error) => {
  console.error(`WS server error: ${error.message}`);
});

function breakEverything() {
  console.log(`\nFULL BREAK (${ERROR_STATUS_CODE}): ${ERROR_RESPONSE_MESSAGE}\n`);
  allowConnections = false;

  for (const bridge of Array.from(bridges)) {
    safeCloseSocket(bridge.client, 1013, ERROR_RESPONSE_MESSAGE);
    safeCloseSocket(bridge.upstream, 1013, "Simulation manually set to DOWN");
    bridge.closed = true;
    bridge.pendingMessages.length = 0;
    bridges.delete(bridge);
  }
}

function fixEverything() {
  console.log("\nFIX: Allow new websocket connections\n");
  allowConnections = true;
}


/* When started by the manager, stdin is a pipe from it. The pipe ending means
   the manager is gone, so there is nobody left to stop this proxy or reuse its
   port - shut down rather than linger. */
if (process.env.SIMPROXY_MANAGED === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

readline
  .createInterface({ input: process.stdin, output: process.stdout })
  .on("close", () => {
    if (process.env.SIMPROXY_MANAGED === "1") process.exit(0);
  })
  .on("line", (cmd) => {
    const trimmed = cmd.trim();
    if (trimmed === "b") breakEverything();
    if (trimmed === "f") fixEverything();
    if (trimmed === "q") process.exit(0);
  });

/*
node ws_proxy.js
node ws_proxy.js 7000
node ws_proxy.js null wss://myserver/myws
node ws_proxy.js 5005 wss://another-chain.com/ws
*/
