const express = require("express");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { rateLimit } = require("express-rate-limit");
const {
  createProxyMiddleware,
  responseInterceptor,
} = require("http-proxy-middleware");
const { mcpHttpHandler, mcpMetadataHandler } = require("./mcp_server");

const app = express();
const PORT = process.env.MANAGER_PORT ? Number(process.env.MANAGER_PORT) : 9090;

const MIN_PORT = 1000;
const MAX_PORT = 65535;
const DEFAULT_ERROR_STATUS = 500;
const DEFAULT_ERROR_MESSAGE = "Service unavailable (simulated)";
const DEFAULT_MAX_REQUESTS_PER_SECOND = 15;
const SSE_DEBUG = process.env.SSE_DEBUG === "1";

// Signing key for user codes. Without one, codes are invalidated by a restart.
const USER_CODE_SECRET =
  process.env.USER_CODE_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.USER_CODE_SECRET) {
  console.warn(
    "USER_CODE_SECRET is not set - a random key was generated, so existing user codes stop working on restart.",
  );
}
/* How long a simulation may live, and how long it may sit unused. A proxy
   holds a port, so both limits exist to give idle ports back. */
function positiveHours(value, fallback) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours : fallback;
}
const MAX_LIFETIME_HOURS = positiveHours(process.env.SIM_MAX_LIFETIME_HOURS, 24);
const IDLE_TIMEOUT_HOURS = positiveHours(process.env.SIM_IDLE_TIMEOUT_HOURS, 3);
const MAX_LIFETIME_MS = MAX_LIFETIME_HOURS * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_HOURS * 60 * 60 * 1000;
/* Check often enough to be accurate against the shorter limit, but never
   more than once a minute in normal use. */
const EXPIRY_SWEEP_MS = Math.max(
  1000,
  Math.min(60 * 1000, Math.floor(Math.min(IDLE_TIMEOUT_MS, MAX_LIFETIME_MS) / 10)),
);

/* Proxies print this on their stdout when they carry traffic. It never
   reaches the log buffer - it only refreshes the idle clock. */
const ACTIVITY_MARKER = "__simproxy_activity__";
/* How often a busy proxy may repeat it: often enough that the idle clock is
   never wrong by much, rarely enough that a busy proxy stays quiet. */
const ACTIVITY_PING_MS = Math.max(250, Math.min(10000, Math.floor(IDLE_TIMEOUT_MS / 20)));

// Operator override. Admin mode is unavailable unless this is set.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
if (!ADMIN_TOKEN) {
  console.warn("ADMIN_TOKEN is not set - admin mode is disabled.");
}

const simulations = new Map();
const logClients = new Set();
let seq = 1;
let sseClientSeq = 1;

const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.path.startsWith("/proxy/")) return next();
  return jsonParser(req, res, next);
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Authorization, X-User-Id, X-User-Code, X-Admin-Token",
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

const sessionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many session requests, please try again later." },
});

const simulationCreateRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many simulation creation requests, please try again later." },
});

const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many MCP requests, please try again later." },
});

function isValidSimulateUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "ws:", "wss:", "tcp:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

app.use(express.static(path.join(__dirname, "public")));

function getExposedIp() {
  const interfaces = os.networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key] || [];
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function buildEndpoint(sim) {
  const scheme = sim.urlType === "ws" ? "ws" : sim.urlType === "db" ? "tcp" : "http";
  return `${scheme}://${getExposedIp()}:${sim.port}`;
}

function getRequestScheme(req) {
  const forwardedProto = req?.headers?.["x-forwarded-proto"];
  if (forwardedProto) return String(forwardedProto).split(",")[0].trim();
  return req?.protocol || "http";
}

function getRequestHost(req) {
  const forwardedHost = req?.headers?.["x-forwarded-host"];
  if (forwardedHost) return String(forwardedHost).split(",")[0].trim();
  const host = req?.get?.("host");
  if (host) return host;
  return `${getExposedIp()}:${PORT}`;
}

function getRequestHostnameOnly(req) {
  const host = getRequestHost(req);
  if (!host) return getExposedIp();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const idx = host.lastIndexOf(":");
  if (idx <= 0) return host;
  return host.slice(0, idx);
}

function isPrivateIpv4Host(hostname) {
  const match = String(hostname || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return false;

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function shouldUseDirectEndpoint(req) {
  const hostname = String(getRequestHostnameOnly(req) || "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    hostname === "host.docker.internal" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4Host(hostname)
  );
}

function buildManagerProxyEndpoint(sim, req) {
  if (shouldUseDirectEndpoint(req)) {
    return buildEndpoint(sim);
  }
  if (sim.urlType === "db") {
    return `tcp://${getRequestHostnameOnly(req)}:${sim.port}`;
  }
  const scheme =
    sim.urlType === "ws" && getRequestScheme(req) === "https"
      ? "wss"
      : getRequestScheme(req);
  const host = getRequestHost(req);
  return `${scheme}://${host}/proxy/${sim.port}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sseDebug(message, meta) {
  if (!SSE_DEBUG) return;
  if (meta !== undefined) console.log(`[SSE-SRV ${nowIso()}] ${message}`, meta);
  else console.log(`[SSE-SRV ${nowIso()}] ${message}`);
}

/* ── User codes ────────────────────────────────────────────────────
   A user code is `uc_<random>.<hmac>`. Only this process can produce a
   valid signature, so a made-up code cannot claim or reach simulations. */
function signUserCodeBody(body) {
  return crypto
    .createHmac("sha256", USER_CODE_SECRET)
    .update(body)
    .digest("base64url")
    .slice(0, 32);
}

function issueUserCode() {
  const body = `uc_${crypto.randomBytes(12).toString("base64url")}`;
  return `${body}.${signUserCodeBody(body)}`;
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a ?? ""));
  const bufferB = Buffer.from(String(b ?? ""));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function isValidUserCode(value) {
  const code = String(value || "").trim();
  const separator = code.lastIndexOf(".");
  if (separator <= 0) return false;
  const body = code.slice(0, separator);
  const signature = code.slice(separator + 1);
  if (!body.startsWith("uc_") || !signature) return false;
  return safeEqual(signature, signUserCodeBody(body));
}

/* Operator access. Requires ADMIN_TOKEN to be configured and presented -
   `?role=admin` on its own grants nothing, from any client. */
function isAdminRequest(req) {
  if (!ADMIN_TOKEN) return false;
  if (req.query.role !== "admin") return false;
  const presented = req.header("x-admin-token") || req.query.admin_key || "";
  return safeEqual(presented, ADMIN_TOKEN);
}

function getRequestUserId(req) {
  const presented =
    req.header("x-user-code") ||
    req.query.user_code ||
    req.header("x-user-id") ||
    req.query.user_id;
  if (!presented) return null;
  const code = String(presented).trim();
  if (!code || !isValidUserCode(code)) return null;
  return code;
}

/* Rejects a request that carries neither a valid user code nor admin rights. */
function requireIdentity(req, res) {
  if (isAdminRequest(req)) return true;
  if (getRequestUserId(req)) return true;
  res.status(401).json({
    error:
      "a valid user code is required - send it as the x-user-code header (get one from GET /api/session)",
  });
  return false;
}

function canAccessSimulation(req, sim) {
  if (isAdminRequest(req)) return true;
  const userId = getRequestUserId(req);
  if (!userId) return false;
  return sim.ownerId === userId;
}

/* Resolves `:id` as either a simulation id (sim-7) or one of the caller's
   ports (5001). Anything the caller does not own resolves to nothing, so a
   stranger cannot even learn that a port is taken. */
function findAccessibleSimulation(req) {
  const key = String(req.params.id || "").trim();
  if (!key) return null;

  const byId = simulations.get(key);
  if (byId) return canAccessSimulation(req, byId) ? byId : null;

  const port = Number(key);
  if (!Number.isInteger(port)) return null;
  for (const sim of simulations.values()) {
    if (sim.port === port && canAccessSimulation(req, sim)) return sim;
  }
  return null;
}

/* Resolves a comma-separated `ids` filter down to the simulation ids that log
   entries carry. Tokens may be ports — the way a simulation is addressed
   everywhere else — or, for compatibility, simulation ids. A filter that
   resolves to nothing is kept verbatim so it matches nothing, as before. */
function resolveLogFilterIds(idsParam, req) {
  const tokens = String(idsParam)
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return null;

  const resolved = new Set();
  for (const token of tokens) {
    const byId = simulations.get(token);
    if (byId && canAccessSimulation(req, byId)) {
      resolved.add(byId.id);
      continue;
    }

    const port = Number(token);
    if (!Number.isInteger(port)) continue;
    for (const sim of simulations.values()) {
      if (sim.port === port && canAccessSimulation(req, sim)) resolved.add(sim.id);
    }
  }

  return resolved.size ? resolved : new Set(tokens);
}

function normalizeSimulationName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function extractHostnameFromValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const candidates = raw.includes("://") ? [raw] : [`http://${raw}`];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname) return parsed.hostname.toLowerCase();
    } catch {
      // Ignore parse errors and continue to the regex fallback below.
    }
  }

  const match = raw.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(?:[/?#]|$)/i);
  if (!match) return "";
  return match[1].replace(/^\[|\]$/g, "").toLowerCase();
}

function stripVersionSuffix(name) {
  return String(name || "").replace(/-v\d+$/i, "");
}

function isNameTakenForOwner(name, ownerId, excludeId = null) {
  const target = normalizeSimulationName(name).toLowerCase();
  if (!target || !ownerId) return false;

  for (const sim of simulations.values()) {
    if (sim.id === excludeId) continue;
    if (sim.ownerId !== ownerId) continue;
    if (normalizeSimulationName(sim.name).toLowerCase() === target) return true;
  }
  return false;
}

function ensureUniqueSimulationName(name, ownerId, excludeId = null) {
  const normalized = normalizeSimulationName(name);
  if (!normalized) return "";
  if (!ownerId || !isNameTakenForOwner(normalized, ownerId, excludeId)) return normalized;

  const root = stripVersionSuffix(normalized) || normalized;
  let version = 1;
  let candidate = `${root}-v${version}`;
  while (isNameTakenForOwner(candidate, ownerId, excludeId)) {
    version += 1;
    candidate = `${root}-v${version}`;
  }
  return candidate;
}

function buildAutoSimulationName(simulateUrl, urlType) {
  const hostname = extractHostnameFromValue(simulateUrl);
  if (!hostname) return "";
  return urlType === "ws" ? `ws-${hostname}` : hostname;
}

function resolveSimulationName({
  requestedName,
  simulateUrl,
  urlType,
  ownerId,
  enforceUnique = false,
  excludeId = null,
  fallbackName = "",
}) {
  const baseName =
    normalizeSimulationName(requestedName) ||
    buildAutoSimulationName(simulateUrl, urlType) ||
    normalizeSimulationName(fallbackName);

  if (!baseName) return "";
  if (!enforceUnique) return baseName;
  return ensureUniqueSimulationName(baseName, ownerId, excludeId);
}

function broadcastLog(entry, ownerId) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    const hasAccess = client.isAdmin || (client.userId && client.userId === ownerId);
    if (!hasAccess) continue;
    // If the client subscribed to specific ids, only send matching ones
    if (client.ids && client.ids.size > 0 && !client.ids.has(entry.id)) continue;
    client.res.write(payload);
  }
}

function appendLog(sim, stream, line) {
  // No owner code in the entry: log lines are handed to clients verbatim.
  const entry = {
    id: sim.id,
    name: sim.name,
    stream,
    line,
    at: nowIso(),
  };
  sim.logs.push(entry);
  if (sim.logs.length > 600) sim.logs.shift();
  broadcastLog(entry, sim.ownerId);
}

function simulationToJson(sim, req) {
  return {
    id: sim.id,
    name: sim.name,
    urlType: sim.urlType,
    script: sim.script,
    port: sim.port,
    simulateUrl: sim.simulateUrl,
    errorStatusCode: sim.errorStatusCode,
    errorResponseMessage: sim.errorResponseMessage,
    maxRequestsPerSecond: sim.maxRequestsPerSecond,
    state: sim.state,
    pid: sim.process ? sim.process.pid : null,
    createdAt: sim.createdAt,
    original_url: sim.simulateUrl,
    proxy_url: buildManagerProxyEndpoint(sim, req),
    last_activity_at: new Date(sim.lastActivityAt).toISOString(),
    expires_at: new Date(Date.parse(sim.createdAt) + MAX_LIFETIME_MS).toISOString(),
    idle_expires_at: new Date(sim.lastActivityAt + IDLE_TIMEOUT_MS).toISOString(),
    logs: sim.logs,
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port)) return null;
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

function parseErrorCode(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_ERROR_STATUS;
  const code = Number(value);
  if (!Number.isInteger(code) || code <= 0) return null;
  return code;
}

function parseMaxRequestsPerSecond(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_REQUESTS_PER_SECOND;
  }
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate <= 0) return null;
  return rate;
}

async function isPortFree(port) {
  for (const sim of simulations.values()) {
    if (sim.port === port && sim.state !== "stopped") return false;
  }

  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "0.0.0.0");
  });
}

async function findFreePort(fromPort = MIN_PORT) {
  const start = Math.max(MIN_PORT, Number(fromPort) || MIN_PORT);
  for (let port = start; port <= MAX_PORT; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(port);
    if (free) return port;
  }
  return null;
}

function startSimulation(sim) {
  const args = [
    sim.script,
    String(sim.port),
    sim.simulateUrl,
    String(sim.errorStatusCode),
    sim.errorResponseMessage,
    String(sim.maxRequestsPerSecond),
  ];

  const child = spawn("node", args, {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    /* Tells the proxy it is manager-run, so it exits if this process dies
       and never outlives it holding a port. */
    env: {
      ...process.env,
      SIMPROXY_MANAGED: "1",
      SIMPROXY_ACTIVITY_PING_MS: String(ACTIVITY_PING_MS),
    },
  });

  sim.process = child;
  sim.state = "up";

  appendLog(sim, "system", `started: node ${args.join(" ")}`);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (line.trim() === ACTIVITY_MARKER) {
        sim.lastActivityAt = Date.now();
        continue;
      }
      appendLog(sim, "stdout", line);
    }
  });

  child.stderr.on("data", (chunk) => {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    for (const line of lines) appendLog(sim, "stderr", line);
  });

  child.on("exit", (code, signal) => {
    sim.state = "stopped";
    sim.process = null;
    appendLog(
      sim,
      "system",
      `exited (code=${code}, signal=${signal || "none"})`,
    );
  });
}

/* Stops the proxy and forgets the simulation, which releases its port. The
   note is broadcast first so anyone watching the logs sees why it went. */
function expireSimulation(sim, reason) {
  appendLog(sim, "system", `expired: ${reason}`);
  if (sim.process && !sim.process.killed) sim.process.kill("SIGTERM");
  simulations.delete(sim.id);
  console.log(`[expiry] ${sim.id} (port ${sim.port}) removed - ${reason}`);
}

function sweepExpiredSimulations() {
  const now = Date.now();
  for (const sim of Array.from(simulations.values())) {
    const age = now - Date.parse(sim.createdAt);
    if (age >= MAX_LIFETIME_MS) {
      expireSimulation(sim, `reached the ${MAX_LIFETIME_HOURS}h maximum lifetime`);
      continue;
    }
    if (now - sim.lastActivityAt >= IDLE_TIMEOUT_MS) {
      expireSimulation(sim, `idle for ${IDLE_TIMEOUT_HOURS}h with no traffic`);
    }
  }
}

setInterval(sweepExpiredSimulations, EXPIRY_SWEEP_MS).unref();

function sendCommand(sim, command) {
  if (!sim.process || sim.process.killed || sim.state === "stopped") {
    throw new Error("Simulation is not running");
  }
  sim.process.stdin.write(`${command}\n`);
}

app.get("/api/session", sessionRateLimiter, (req, res) => {
  const presented = req.header("x-user-code") || req.query.user_code;
  if (presented && isValidUserCode(String(presented).trim())) {
    return res.json({ user_code: String(presented).trim(), reused: true });
  }
  return res.json({ user_code: issueUserCode(), reused: false });
});

app.get("/api/version", (req, res) => {
  res.json({ version: require("./package.json").version });
});

app.post("/mcp", mcpRateLimiter, mcpHttpHandler);
app.get("/mcp", mcpMetadataHandler);

app.get("/api/simulations", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const all = Array.from(simulations.values());
  if (isAdminRequest(req)) {
    return res.json(all.map((sim) => simulationToJson(sim, req)));
  }

  const userId = getRequestUserId(req);
  if (!userId) return res.json([]);

  const filtered = all.filter((sim) => sim.ownerId === userId);
  return res.json(filtered.map((sim) => simulationToJson(sim, req)));
});

app.get("/api/simulations/:id/logs", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const sim = findAccessibleSimulation(req);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });

  return res.json({ id: sim.id, logs: sim.logs.slice(-300) });
});

app.post("/api/simulations", simulationCreateRateLimiter, async (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const isAdmin = isAdminRequest(req);
  const ownerId = getRequestUserId(req);
  const requestedName = req.body.name ? String(req.body.name).trim() : "";
  const rawUrlType = req.body.url_type ? String(req.body.url_type).trim().toLowerCase() : "";
  const urlType = rawUrlType === "database" ? "db" : rawUrlType;
  const portRequested =
    req.body.port !== undefined && req.body.port !== null && req.body.port !== "";
  const port = portRequested ? parsePort(req.body.port) : null;
  const simulateUrl = req.body.simulate_url
    ? String(req.body.simulate_url).trim()
    : "";
  const errorStatusCode = parseErrorCode(req.body.error_status_code);
  const errorResponseMessage = req.body.error_response_message
    ? String(req.body.error_response_message).trim()
    : DEFAULT_ERROR_MESSAGE;
  const maxRequestsPerSecond = parseMaxRequestsPerSecond(
    req.body.max_requests_per_second ?? req.body.max_throughput_rps,
  );

  const isCustomJson = Boolean(req.body.is_custom_json) ||
    errorResponseMessage.startsWith("{") ||
    errorResponseMessage.startsWith("[");

  if (isCustomJson) {
    try {
      JSON.parse(errorResponseMessage);
    } catch (jsonErr) {
      return res.status(400).json({
        error: `error_response_message must be a valid JSON object/string: ${jsonErr.message}`,
      });
    }
  }

  if (!["http", "ws", "db"].includes(urlType)) {
    return res.status(400).json({ error: "url_type must be 'http', 'ws', or 'db'" });
  }

  if (portRequested && !port) {
    return res.status(400).json({
      error: `port must be an integer from ${MIN_PORT} to ${MAX_PORT}`,
    });
  }

  if (!simulateUrl || !isValidSimulateUrl(simulateUrl)) {
    return res.status(400).json({ error: "simulate_url must be a valid HTTP, HTTPS, WS, WSS, or TCP URL" });
  }


  if (errorStatusCode === null) {
    return res
      .status(400)
      .json({ error: "error_status_code must be an integer greater than 0" });
  }

  if (maxRequestsPerSecond === null) {
    return res.status(400).json({
      error: "max_requests_per_second must be an integer greater than 0",
    });
  }

  // No port given: take the next free one rather than making the caller guess.
  let resolvedPort = port;
  if (!resolvedPort) {
    resolvedPort = await findFreePort(MIN_PORT);
    if (!resolvedPort) {
      return res.status(503).json({ error: "no free port is currently available" });
    }
  } else {
    const free = await isPortFree(resolvedPort);
    if (!free) {
      const suggested = await findFreePort(resolvedPort + 1);
      return res.status(409).json({
        error: `port ${resolvedPort} is already in use`,
        suggested_port: suggested,
        retry_with: suggested ? { port: suggested } : undefined,
      });
    }
  }

  const script =
    urlType === "http" ? "rpc_proxy.js" : urlType === "ws" ? "ws_proxy.js" : "db_proxy.js";
  const nextSeq = seq;
  const id = `sim-${nextSeq}`;
  seq += 1;
  const resolvedOwnerId = ownerId || "admin";
  const resolvedName = resolveSimulationName({
    requestedName,
    simulateUrl,
    urlType,
    ownerId: resolvedOwnerId,
    enforceUnique: !isAdmin,
    fallbackName: `Simulation-${nextSeq}`,
  });

  const sim = {
    id,
    name: resolvedName || `Simulation-${nextSeq}`,
    urlType,
    script,
    port: resolvedPort,
    simulateUrl,
    errorStatusCode,
    errorResponseMessage,
    maxRequestsPerSecond,
    state: "starting",
    process: null,
    logs: [],
    ownerId: resolvedOwnerId,
    createdAt: nowIso(),
    lastActivityAt: Date.now(),
  };

  simulations.set(id, sim);
  startSimulation(sim);

  return res.status(201).json(simulationToJson(sim, req));
});

/* Rename. POST is the documented verb - PATCH is blocked by some corporate
   proxies and older clients - and PATCH stays accepted for existing scripts. */
function renameSimulation(req, res) {
  if (!requireIdentity(req, res)) return undefined;
  const sim = findAccessibleSimulation(req);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });

  const requestedName = req.body && Object.prototype.hasOwnProperty.call(req.body, "name")
    ? req.body.name
    : "";
  const nextName = resolveSimulationName({
    requestedName,
    simulateUrl: sim.simulateUrl,
    urlType: sim.urlType,
    ownerId: sim.ownerId,
    enforceUnique: !isAdminRequest(req),
    excludeId: sim.id,
    fallbackName: sim.name || sim.id,
  });

  if (!nextName) {
    return res.status(400).json({ error: "name is required" });
  }

  if (nextName !== sim.name) {
    sim.name = nextName;
    appendLog(sim, "system", `renamed to ${nextName}`);
  }

  return res.json(simulationToJson(sim, req));
}

app.post("/api/simulations/:id", renameSimulation);
app.patch("/api/simulations/:id", renameSimulation);

app.post("/api/simulations/:id/down", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const sim = findAccessibleSimulation(req);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });

  try {
    sendCommand(sim, "b");
    sim.state = "down";
    // appendLog(sim, "system", "command sent: b (DOWN)");
    return res.json(simulationToJson(sim, req));
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

app.post("/api/simulations/:id/up", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const sim = findAccessibleSimulation(req);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });

  try {
    sendCommand(sim, "f");
    sim.state = "up";
    // appendLog(sim, "system", "command sent: f (UP)");
    return res.json(simulationToJson(sim, req));
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

app.delete("/api/simulations/:id", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const sim = findAccessibleSimulation(req);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });

  const hadProcess = Boolean(sim.process && !sim.process.killed);
  if (sim.process && !sim.process.killed) {
    sim.process.kill("SIGTERM");
  }

  simulations.delete(sim.id);
  return res.json({
    id: sim.id,
    deleted: true,
    process_termination_requested: hadProcess,
  });
});

app.get("/api/ports/suggest", async (req, res) => {
  const from = parsePort(req.query.from) || MIN_PORT;
  const suggested = await findFreePort(from);
  if (!suggested)
    return res.status(404).json({ error: "No free port available" });

  return res.json({ suggested_port: suggested });
});

/* Is one specific port free? `/api/ports/suggest` answers "the next free port
   at or above N", which only tells you about N by implication. Like suggest,
   this needs no user code — it reports nothing about anyone's simulations
   beyond whether the port is taken. */
app.get("/api/ports/check", async (req, res) => {
  const port = parsePort(req.query.port);
  if (!port) {
    return res.status(400).json({
      error: `port must be an integer between ${MIN_PORT} and ${MAX_PORT}`,
    });
  }

  if (await isPortFree(port)) {
    return res.json({ port, available: true });
  }

  /* Same fields the create route returns on a 409, so a caller can retry
     straight away instead of making a second round trip. */
  const suggested = await findFreePort(port);
  return res.json({
    port,
    available: false,
    suggested_port: suggested,
    retry_with: suggested ? { port: suggested } : undefined,
  });
});

app.get("/api/logs/stream", (req, res) => {
  if (!requireIdentity(req, res)) return undefined;
  const clientId = `sse-${sseClientSeq}`;
  sseClientSeq += 1;
  const connectedAt = Date.now();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Optional filter: ?ids=5001,5002 (ports) — simulation ids also accepted.
  const idsParam = req.query.ids ? String(req.query.ids).trim() : "";
  const filterIds = idsParam
    ? resolveLogFilterIds(idsParam, req)
    : null; // null = no filter (all accessible)
  const rawBacklog = Number(req.query.backlog);
  const backlogLimit =
    Number.isInteger(rawBacklog) && rawBacklog >= 0
      ? Math.min(rawBacklog, 300)
      : 50;
  const userId = getRequestUserId(req);
  const isAdmin = isAdminRequest(req);
  sseDebug("client connected", {
    clientId,
    isAdmin,
    userId,
    ids: filterIds ? Array.from(filterIds) : [],
    backlogLimit,
    ip:
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "unknown",
    ua: req.headers["user-agent"] || "",
  });

  const backlog = [];
  for (const sim of simulations.values()) {
    if (!canAccessSimulation(req, sim)) continue;
    if (filterIds && !filterIds.has(sim.id)) continue;
    if (backlogLimit > 0) backlog.push(...sim.logs.slice(-backlogLimit));
  }

  backlog.sort((a, b) => (a.at > b.at ? 1 : -1));
  for (const entry of backlog) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  sseDebug("backlog sent", {
    clientId,
    entries: backlog.length,
  });

  const initialHeartbeatIds = [];
  for (const sim of simulations.values()) {
    if (!canAccessSimulation(req, sim)) continue;
    if (filterIds && !filterIds.has(sim.id)) continue;
    initialHeartbeatIds.push(sim.id);
  }
  res.write(
    `data: ${JSON.stringify({
      type: "heartbeat",
      ids: initialHeartbeatIds,
      at: nowIso(),
    })}\n\n`,
  );

  const client = {
    res,
    isAdmin,
    userId,
    ids: filterIds, // Set<string> or null
    clientId,
  };
  logClients.add(client);

  function getHeartbeatIds() {
    const ids = [];
    for (const sim of simulations.values()) {
      if (!canAccessSimulation(req, sim)) continue;
      if (filterIds && !filterIds.has(sim.id)) continue;
      ids.push(sim.id);
    }
    return ids;
  }

  let keepaliveTicks = 0;
  // Send per-terminal heartbeat every 5s to survive proxy idle/buffering.
  const keepalive = setInterval(() => {
    try {
      keepaliveTicks += 1;
      const heartbeat = {
        type: "heartbeat",
        ids: getHeartbeatIds(),
        at: nowIso(),
      };
      res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
      if (keepaliveTicks <= 3 || keepaliveTicks % 12 === 0) {
        sseDebug("heartbeat sent", {
          clientId,
          tick: keepaliveTicks,
          ids: heartbeat.ids,
        });
      }
    } catch (error) {
      sseDebug("heartbeat write failed", {
        clientId,
        tick: keepaliveTicks,
        error: error?.message || String(error),
      });
      clearInterval(keepalive);
    }
  }, 5000);

  req.on("close", () => {
    clearInterval(keepalive);
    logClients.delete(client);
    sseDebug("client disconnected", {
      clientId,
      connectedForMs: Date.now() - connectedAt,
      heartbeatsSent: keepaliveTicks,
    });
  });
});

function getProxyTarget(req) {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) return null;

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim) return null;
  return `http://127.0.0.1:${sim.port}`;
}

function getProxyPathPrefix(req) {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) return "";
  return `/proxy/${requestedPort}`;
}

function rewriteLocationHeader(locationValue, req) {
  if (!locationValue) return locationValue;
  const prefix = getProxyPathPrefix(req);
  if (!prefix) return locationValue;
  if (locationValue.startsWith(prefix)) return locationValue;
  if (locationValue.startsWith("http://") || locationValue.startsWith("https://")) {
    return locationValue;
  }
  if (locationValue.startsWith("/")) return `${prefix}${locationValue}`;
  return `${prefix}/${locationValue}`;
}

function rewriteWebsiteBody(content, req) {
  const prefix = getProxyPathPrefix(req);
  if (!prefix) return content;

  let updated = content;
  updated = updated.replace(
    /((?:href|src|action)=["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  updated = updated.replace(
    /(url\(["']?)\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  updated = updated.replace(
    /(fetch\(["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  return updated;
}

function shouldRewriteWebsiteResponse(req) {
  if (req.method !== "GET") return false;
  const pathname = String(req.path || "").toLowerCase();
  // API/RPC style routes should never go through HTML/CSS rewrite proxy.
  if (pathname.startsWith("/rpc/") || pathname.startsWith("/api/")) return false;

  if (pathname.endsWith(".css")) return true;

  const accept = String(req.headers.accept || "").toLowerCase();
  // Keep HTML rewrite limited to likely website/document requests.
  if (!accept.includes("text/html")) return false;

  // Typical web document/static paths.
  if (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".htm") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".mjs") ||
    pathname.endsWith(".map") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".gif") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".woff") ||
    pathname.endsWith(".woff2")
  ) {
    return true;
  }

  return false;
}

const simulationStreamProxy = createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  ws: true,
  router: getProxyTarget,
  onProxyRes(proxyRes, req) {
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocationHeader(proxyRes.headers.location, req);
    }
  },
  onError(err, req, res) {
    console.error("Proxy route error:", err.message);
    if (res && !res.headersSent) {
      res.status(502).json({ error: "Proxy forwarding failed" });
    }
  },
});

const simulationRewriteProxy = createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  ws: false,
  selfHandleResponse: true,
  router: getProxyTarget,
  onProxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocationHeader(proxyRes.headers.location, req);
    }

    const contentType = String(proxyRes.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("text/css")) {
      const text = buffer.toString("utf8");
      return rewriteWebsiteBody(text, req);
    }
    return buffer;
  }),
  onError(err, req, res) {
    console.error("Proxy route error:", err.message);
    if (res && !res.headersSent) {
      res.status(502).json({ error: "Proxy forwarding failed" });
    }
  },
});

app.use("/proxy/:port", (req, res, next) => {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) {
    return res.status(400).json({ error: "Invalid simulation port" });
  }

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  sim.lastActivityAt = Date.now();
  if (sim.urlType === "db") {
    return res.status(400).json({
      error: "Database simulations are raw TCP and are not available under /proxy.",
    });
  }
  if (sim.state === "stopped") {
    return res.status(503).json({ error: "Simulation is not running" });
  }
  if (shouldRewriteWebsiteResponse(req)) {
    return simulationRewriteProxy(req, res, next);
  }
  return simulationStreamProxy(req, res, next);
});

/* A proxy is a separate process, so without this a restart would leave every
   one of them running and every port taken, with nothing tracking them. */
let shuttingDown = false;
function stopEverySimulation() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const sim of simulations.values()) {
    if (sim.process && !sim.process.killed) sim.process.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopEverySimulation();
    process.exit(0);
  });
}
process.on("exit", stopEverySimulation);

const server = app.listen(PORT, () => {
  console.log(`Simulation manager running at http://localhost:${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  const match = req.url && req.url.match(/^\/proxy\/([^/?#]+)/);
  if (!match) return;

  const requestedPort = Number(match[1]);
  if (!Number.isInteger(requestedPort)) {
    socket.destroy();
    return;
  }

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim || sim.state === "stopped") {
    socket.destroy();
    return;
  }
  sim.lastActivityAt = Date.now();
  if (sim.urlType === "db") {
    socket.destroy();
    return;
  }

  req.params = { port: String(requestedPort) };
  simulationStreamProxy.upgrade(req, socket, head);
});
