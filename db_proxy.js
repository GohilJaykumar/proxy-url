const net = require("net");

const PORT = process.argv[2] ? Number(process.argv[2]) : 7000;
const TARGET = process.argv[3] ? String(process.argv[3]).trim() : "";
const MAX_CONNECTIONS_PER_SECOND =
  process.argv[6] && Number(process.argv[6]) > 0 ? Number(process.argv[6]) : 30;

if (!TARGET) {
  console.error("Please provide a target DB host/port.");
  console.log("Example:");
  console.log("node db_proxy.js 7000 db.example.com:5432");
  process.exit(1);
}

function parseTarget(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  try {
    const withScheme = input.includes("://") ? input : `tcp://${input}`;
    const parsed = new URL(withScheme);
    const host = parsed.hostname;
    const port = Number(parsed.port || "5432");
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

const target = parseTarget(TARGET);
if (!target) {
  console.error("Invalid target. Use host:port, tcp://host:port, or postgres://...:port");
  process.exit(1);
}

let isBroken = false;
let windowStartMs = Date.now();
let connectionCountInWindow = 0;

function isRateLimited() {
  const now = Date.now();
  if (now - windowStartMs >= 1000) {
    windowStartMs = now;
    connectionCountInWindow = 0;
  }
  connectionCountInWindow += 1;
  return connectionCountInWindow > MAX_CONNECTIONS_PER_SECOND;
}


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

const server = net.createServer((clientSocket) => {
  markActivity();

  if (isRateLimited()) {
    console.log(`rate limited connection from ${clientSocket.remoteAddress || "unknown"}`);
    clientSocket.destroy();
    return;
  }

  if (isBroken) {
    console.log(`proxy down - rejected ${clientSocket.remoteAddress || "unknown"}`);
    clientSocket.destroy();
    return;
  }

  const upstreamSocket = net.createConnection({
    host: target.host,
    port: target.port,
  });

  upstreamSocket.on("connect", () => {
    console.log(
      `connected ${clientSocket.remoteAddress || "unknown"} -> ${target.host}:${target.port}`,
    );
  });

  upstreamSocket.on("error", (error) => {
    console.error(`upstream error: ${error.message}`);
    clientSocket.destroy();
  });

  clientSocket.on("error", (error) => {
    console.error(`client socket error: ${error.message}`);
    upstreamSocket.destroy();
  });

  clientSocket.on("data", markActivity);
  upstreamSocket.on("data", markActivity);

  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
});

server.on("error", (error) => {
  console.error(`server error: ${error.message}`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DB proxy running at tcp://0.0.0.0:${PORT}`);
  console.log(`Forwarding to ${target.host}:${target.port}`);
  console.log(`Max new connections/sec: ${MAX_CONNECTIONS_PER_SECOND}`);
  console.log("Commands: (b) break | (f) fix");
});


/* When started by the manager, stdin is a pipe from it. The pipe ending means
   the manager is gone, so there is nobody left to stop this proxy or reuse its
   port - shut down rather than linger. */
if (process.env.SIMPROXY_MANAGED === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

process.stdin.on("data", (input) => {
  const cmd = input.toString().trim().toLowerCase();
  if (cmd === "b") {
    isBroken = true;
    console.log("DB proxy manually set to DOWN");
  } else if (cmd === "f") {
    isBroken = false;
    console.log("DB proxy manually set to UP");
  }
});
