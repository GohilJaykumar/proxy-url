const http = require("http");
const { URL } = require("url");

const DEFAULT_MANAGER_PORT = process.env.MANAGER_PORT || 9090;
const DEFAULT_MANAGER_URL = process.env.MANAGER_URL || `http://127.0.0.1:${DEFAULT_MANAGER_PORT}`;

function makeApiRequest({ method = "GET", path, body = null, userCode = null, managerUrl = DEFAULT_MANAGER_URL }) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(path, managerUrl);
      const payload = body ? JSON.stringify(body) : null;

      const headers = {
        "Accept": "application/json",
      };
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      if (userCode) {
        headers["x-user-code"] = userCode;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: method.toUpperCase(),
        headers,
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (e) {
            parsed = { raw: data };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errorMsg = parsed.error || `HTTP ${res.statusCode}: ${data}`;
            const err = new Error(errorMsg);
            err.statusCode = res.statusCode;
            err.data = parsed;
            reject(err);
          }
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Failed to connect to manager at ${managerUrl}: ${err.message}`));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

const toolDefinitions = [
  {
    name: "create_simulation",
    description: "Create a new proxy simulation that forwards traffic to a target URL. Supports HTTP, WebSocket, and Database (TCP) proxy types. Returns the proxy URL that clients can use.",
    inputSchema: {
      type: "object",
      properties: {
        simulate_url: {
          type: "string",
          description: "The target URL to proxy traffic to (e.g., https://rpc.example.com, wss://ws.example.com, postgres://db:5432)"
        },
        url_type: {
          type: "string",
          enum: ["http", "ws", "db"],
          description: "Type of proxy: 'http' for REST/RPC, 'ws' for WebSocket, 'db' for database TCP connections"
        },
        name: {
          type: "string",
          description: "Optional human-readable name for the simulation"
        },
        port: {
          type: "integer",
          description: "Optional specific port to use (auto-assigned if omitted)"
        },
        error_status_code: {
          type: "integer",
          description: "HTTP status code to return when simulation is in DOWN state (default: 500)"
        },
        error_response_message: {
          type: "string",
          description: "Error message returned when simulation is DOWN (default: 'Service unavailable (simulated)')"
        },
        max_requests_per_second: {
          type: "integer",
          description: "Rate limit for the proxy (default: 15 req/s)"
        }
      },
      required: ["simulate_url", "url_type"]
    }
  },
  {
    name: "list_simulations",
    description: "List all proxy simulations owned by your Sim-Code. Returns simulation details including port, name, type, state (up/down/stopped), proxy URL, and expiry times.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_simulation",
    description: "Get detailed information about a specific simulation by its port number (e.g. 5001).",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation (e.g. 5001)"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "simulation_down",
    description: "Set a simulation to DOWN state by its port number. The proxy will reject all requests with the configured error status code and message.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation (e.g. 5001)"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "simulation_up",
    description: "Set a simulation back to UP state by its port number. The proxy resumes normal forwarding to the target URL.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation (e.g. 5001)"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "delete_simulation",
    description: "Stop and permanently delete a simulation by its port number, freeing the port it was using.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation to delete (e.g. 5001)"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "rename_simulation",
    description: "Rename an existing simulation by its port number to a new human-readable name.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation (e.g. 5001)"
        },
        name: {
          type: "string",
          description: "New name for the simulation"
        }
      },
      required: ["port", "name"]
    }
  },
  {
    name: "get_simulation_logs",
    description: "Get recent log entries from a simulation by its port number. Returns up to 300 most recent log lines including stdout, stderr, and system events.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation (e.g. 5001)"
        },
        limit: {
          type: "integer",
          description: "Maximum number of log lines to return (default: 50, max: 300)"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "check_port",
    description: "Check if a specific port is available for use, or get a suggestion for the next free port.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number to check availability"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "suggest_port",
    description: "Find the next available port starting from an optional minimum port number.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "integer",
          description: "Minimum port to start searching from (default: 1000)"
        }
      },
      required: []
    }
  },
  {
    name: "delete_all_stopped",
    description: "Delete all simulations owned by your Sim-Code that are currently in 'stopped' state. Frees up ports and cleans up stale entries.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "clone_simulation",
    description: "Clone an existing simulation by its port number with optional overrides (different rate limit, error status, or name).",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port number of the simulation to clone (e.g. 5001)"
        },
        name: {
          type: "string",
          description: "Optional new name (auto-versioned if omitted)"
        },
        max_requests_per_second: {
          type: "integer",
          description: "Override rate limit for the clone"
        },
        error_status_code: {
          type: "integer",
          description: "Override error status code for the clone"
        },
        error_response_message: {
          type: "string",
          description: "Override error message for the clone"
        }
      },
      required: ["port"]
    }
  },
  {
    name: "bulk_status_change",
    description: "Change the state of multiple simulations at once by their port numbers. Set them all to UP or DOWN. Useful for chaos testing.",
    inputSchema: {
      type: "object",
      properties: {
        ports: {
          type: "array",
          items: { type: "string" },
          description: "Array of simulation port numbers (e.g. ['5001', '5002']). Use ['all'] to target every running simulation owned by your Sim-Code."
        },
        action: {
          type: "string",
          enum: ["up", "down"],
          description: "Set simulations to 'up' (resume forwarding) or 'down' (reject traffic)"
        }
      },
      required: ["ports", "action"]
    }
  }
];

function resolvePortArg(args) {
  const p = args.port !== undefined && args.port !== null ? args.port : args.id;
  if (p === undefined || p === null || p === "") {
    throw new Error("Port number is required");
  }
  return String(p).trim();
}

async function executeTool(name, args, { userCode, managerUrl = DEFAULT_MANAGER_URL }) {
  if (!userCode && !process.env.ADMIN_TOKEN) {
    throw new Error("Authentication required: a valid Sim-Code (x-user-code) is required to perform simulation actions.");
  }

  switch (name) {
    case "create_simulation": {
      const res = await makeApiRequest({
        method: "POST",
        path: "/api/simulations",
        body: args,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Successfully created simulation '${res.name}' on port ${res.port}.\nProxy URL: ${res.proxy_url}\nOriginal URL: ${res.simulateUrl}\nState: ${res.state}`,
          },
        ],
      };
    }

    case "list_simulations": {
      const simulations = await makeApiRequest({
        method: "GET",
        path: "/api/simulations",
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simulations, null, 2),
          },
        ],
      };
    }

    case "get_simulation": {
      const targetPortStr = resolvePortArg(args);
      const simulations = await makeApiRequest({
        method: "GET",
        path: "/api/simulations",
        userCode,
        managerUrl,
      });
      const targetPort = Number(targetPortStr);
      const sim = simulations.find(
        (s) => s.port === targetPort || String(s.port) === targetPortStr || s.id === targetPortStr
      );
      if (!sim) {
        throw new Error(`Simulation on port '${targetPortStr}' not found or not owned by your Sim-Code`);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sim, null, 2),
          },
        ],
      };
    }

    case "simulation_down": {
      const targetPortStr = resolvePortArg(args);
      const res = await makeApiRequest({
        method: "POST",
        path: `/api/simulations/${encodeURIComponent(targetPortStr)}/down`,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Simulation on port ${res.port} ('${res.name}') is now DOWN. Returning status code ${res.errorStatusCode}.`,
          },
        ],
      };
    }

    case "simulation_up": {
      const targetPortStr = resolvePortArg(args);
      const res = await makeApiRequest({
        method: "POST",
        path: `/api/simulations/${encodeURIComponent(targetPortStr)}/up`,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Simulation on port ${res.port} ('${res.name}') is now UP and forwarding traffic.`,
          },
        ],
      };
    }

    case "delete_simulation": {
      const targetPortStr = resolvePortArg(args);
      const res = await makeApiRequest({
        method: "DELETE",
        path: `/api/simulations/${encodeURIComponent(targetPortStr)}`,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Simulation on port ${targetPortStr} (id: ${res.id}) successfully deleted. Port freed.`,
          },
        ],
      };
    }

    case "rename_simulation": {
      const targetPortStr = resolvePortArg(args);
      const res = await makeApiRequest({
        method: "POST",
        path: `/api/simulations/${encodeURIComponent(targetPortStr)}`,
        body: { name: args.name },
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Simulation on port ${res.port} successfully renamed to '${res.name}'.`,
          },
        ],
      };
    }

    case "get_simulation_logs": {
      const targetPortStr = resolvePortArg(args);
      const limit = args.limit || 50;
      const res = await makeApiRequest({
        method: "GET",
        path: `/api/simulations/${encodeURIComponent(targetPortStr)}/logs`,
        userCode,
        managerUrl,
      });
      const logs = (res.logs || []).slice(-limit);
      return {
        content: [
          {
            type: "text",
            text: logs.map((l) => `[${l.at}] [${l.stream}] ${l.line}`).join("\n") || "No logs available.",
          },
        ],
      };
    }

    case "check_port": {
      const res = await makeApiRequest({
        method: "GET",
        path: `/api/ports/check?port=${encodeURIComponent(args.port)}`,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "suggest_port": {
      const fromParam = args.from ? `?from=${encodeURIComponent(args.from)}` : "";
      const res = await makeApiRequest({
        method: "GET",
        path: `/api/ports/suggest${fromParam}`,
        userCode,
        managerUrl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Suggested free port: ${res.suggested_port}`,
          },
        ],
      };
    }

    case "delete_all_stopped": {
      const simulations = await makeApiRequest({
        method: "GET",
        path: "/api/simulations",
        userCode,
        managerUrl,
      });
      const stopped = simulations.filter((s) => s.state === "stopped");
      const deletedPorts = [];
      for (const sim of stopped) {
        try {
          await makeApiRequest({
            method: "DELETE",
            path: `/api/simulations/${encodeURIComponent(sim.port)}`,
            userCode,
            managerUrl,
          });
          deletedPorts.push(sim.port);
        } catch (e) {
          // ignore individual deletion errors if already deleted
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Deleted ${deletedPorts.length} stopped simulation(s) on ports: ${deletedPorts.join(", ") || "none"}`,
          },
        ],
      };
    }

    case "clone_simulation": {
      const targetPortStr = resolvePortArg(args);
      const simulations = await makeApiRequest({
        method: "GET",
        path: "/api/simulations",
        userCode,
        managerUrl,
      });
      const targetPort = Number(targetPortStr);
      const sourceSim = simulations.find(
        (s) => s.port === targetPort || String(s.port) === targetPortStr || s.id === targetPortStr
      );
      if (!sourceSim) {
        throw new Error(`Source simulation on port '${targetPortStr}' not found`);
      }

      const clonePayload = {
        simulate_url: sourceSim.simulateUrl,
        url_type: sourceSim.urlType,
        name: args.name || `${sourceSim.name}-clone`,
        error_status_code: args.error_status_code !== undefined ? args.error_status_code : sourceSim.errorStatusCode,
        error_response_message: args.error_response_message !== undefined ? args.error_response_message : sourceSim.errorResponseMessage,
        max_requests_per_second: args.max_requests_per_second !== undefined ? args.max_requests_per_second : sourceSim.maxRequestsPerSecond,
      };

      const newSim = await makeApiRequest({
        method: "POST",
        path: "/api/simulations",
        body: clonePayload,
        userCode,
        managerUrl,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully cloned simulation on port ${sourceSim.port} to new simulation on port ${newSim.port}.\nProxy URL: ${newSim.proxy_url}`,
          },
        ],
      };
    }

    case "bulk_status_change": {
      const action = String(args.action).toLowerCase();
      if (!["up", "down"].includes(action)) {
        throw new Error("action must be 'up' or 'down'");
      }

      const simulations = await makeApiRequest({
        method: "GET",
        path: "/api/simulations",
        userCode,
        managerUrl,
      });

      const rawPorts = args.ports || args.ids || [];
      let targetSims = [];
      if (Array.isArray(rawPorts) && rawPorts.includes("all")) {
        targetSims = simulations.filter((s) => s.state !== "stopped");
      } else if (Array.isArray(rawPorts)) {
        const portSet = new Set(rawPorts.map((i) => String(i).trim()));
        targetSims = simulations.filter(
          (s) => portSet.has(String(s.port)) || portSet.has(s.id)
        );
      }

      const updatedPorts = [];
      const errors = [];
      for (const sim of targetSims) {
        try {
          await makeApiRequest({
            method: "POST",
            path: `/api/simulations/${encodeURIComponent(sim.port)}/${action}`,
            userCode,
            managerUrl,
          });
          updatedPorts.push(sim.port);
        } catch (err) {
          errors.push(`port ${sim.port}: ${err.message}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Updated ${updatedPorts.length} simulation(s) to ${action.toUpperCase()} on ports: ${updatedPorts.join(", ") || "none"}${errors.length ? `\nErrors: ${errors.join("; ")}` : ""}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = {
  definitions: toolDefinitions,
  execute: executeTool,
  makeApiRequest,
};
