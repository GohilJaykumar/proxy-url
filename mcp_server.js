const readline = require("readline");
const mcpTools = require("./mcp_tools");
const mcpResources = require("./mcp_resources");
const mcpPrompts = require("./mcp_prompts");
const packageJson = require("./package.json");

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = {
  name: "proxy-url",
  version: packageJson.version,
};

const CAPABILITIES = {
  tools: {},
  resources: {},
  prompts: {},
};

/**
 * Core JSON-RPC request processor.
 */
async function processJsonRpcRequest(request, context = {}) {
  const { id, method, params } = request || {};
  const { userCode, managerUrl } = context;

  // Handles notifications (methods without an id)
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
          },
        };

      case "notifications/initialized":
      case "initialized":
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, result: {} };

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: mcpTools.definitions,
          },
        };

      case "tools/call": {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        if (!toolName) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing required parameter: 'name'" },
          };
        }

        try {
          const result = await mcpTools.execute(toolName, toolArgs, { userCode, managerUrl });
          return {
            jsonrpc: "2.0",
            id,
            result,
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Tool execution error: ${err.message}`,
                },
              ],
            },
          };
        }
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: mcpResources.staticResources,
          },
        };

      case "resources/templates/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resourceTemplates: mcpResources.resourceTemplates,
          },
        };

      case "resources/read": {
        const uri = params && params.uri;
        if (!uri) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing required parameter: 'uri'" },
          };
        }

        try {
          const result = await mcpResources.readResource(uri, { userCode, managerUrl });
          return {
            jsonrpc: "2.0",
            id,
            result,
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: err.message },
          };
        }
      }

      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: mcpPrompts.definitions,
          },
        };

      case "prompts/get": {
        const promptName = params && params.name;
        const promptArgs = (params && params.arguments) || {};
        if (!promptName) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing required parameter: 'name'" },
          };
        }

        try {
          const result = mcpPrompts.getPrompt(promptName, promptArgs);
          return {
            jsonrpc: "2.0",
            id,
            result,
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: err.message },
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal server error: ${err.message}` },
    };
  }
}

/**
 * Express middleware handler for Streamable HTTP transport (POST /mcp).
 */
async function mcpHttpHandler(req, res) {
  const userCode =
    req.header("x-user-code") ||
    req.query.user_code ||
    req.header("x-user-id") ||
    process.env.SIM_CODE;

  const managerPort = process.env.MANAGER_PORT || 9090;
  const managerUrl = process.env.MANAGER_URL || `http://127.0.0.1:${managerPort}`;

  const requestBody = req.body;
  if (!requestBody || typeof requestBody !== "object") {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: Request body must be a valid JSON object" },
    });
  }

  const response = await processJsonRpcRequest(requestBody, { userCode, managerUrl });

  if (!response) {
    return res.status(204).end();
  }

  return res.json(response);
}

/**
 * GET /mcp handler for server discovery and metadata.
 */
function mcpMetadataHandler(req, res) {
  return res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
    transports: ["streamable-http", "stdio"],
    endpoint: "/mcp",
  });
}

/**
 * stdio mode initialization.
 */
function startStdioServer() {
  const userCode = process.env.SIM_CODE || process.env.USER_CODE || null;
  const managerPort = process.env.MANAGER_PORT || 9090;
  const managerUrl = process.env.MANAGER_URL || `http://127.0.0.1:${managerPort}`;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let jsonReq;
    try {
      jsonReq = JSON.parse(trimmed);
    } catch (e) {
      const errRes = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      };
      process.stdout.write(JSON.stringify(errRes) + "\n");
      return;
    }

    const response = await processJsonRpcRequest(jsonReq, { userCode, managerUrl });
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });

  process.stderr.write(`[MCP] Proxy URL MCP Server running in stdio mode (Version: ${packageJson.version})\n`);
}

if (require.main === module) {
  if (process.argv.includes("--stdio")) {
    startStdioServer();
  } else {
    console.log("Usage: node mcp_server.js --stdio");
    console.log("Or import mcpHttpHandler and mount on Express.");
  }
}

module.exports = {
  mcpHttpHandler,
  mcpMetadataHandler,
  processJsonRpcRequest,
  startStdioServer,
};
