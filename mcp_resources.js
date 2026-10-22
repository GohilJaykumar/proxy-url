const { makeApiRequest } = require("./mcp_tools");
const packageJson = require("./package.json");

const resourceTemplates = [
  {
    uriTemplate: "proxy://simulations/{id}",
    name: "Simulation Details",
    description: "Get detailed information about a specific proxy simulation",
    mimeType: "application/json",
  },
  {
    uriTemplate: "proxy://simulations/{id}/logs",
    name: "Simulation Logs",
    description: "Get recent logs for a specific proxy simulation",
    mimeType: "application/json",
  },
];

const staticResources = [
  {
    uri: "proxy://simulations",
    name: "Active Simulations",
    description: "List all active proxy simulations with their current status",
    mimeType: "application/json",
  },
  {
    uri: "proxy://server/status",
    name: "Server Status",
    description: "Server health, version, uptime, and configuration metadata",
    mimeType: "application/json",
  },
];

async function readResource(uri, { userCode, managerUrl }) {
  const parsedUri = String(uri).trim();

  if (parsedUri === "proxy://simulations") {
    const simulations = await makeApiRequest({
      method: "GET",
      path: "/api/simulations",
      userCode,
      managerUrl,
    });
    return {
      contents: [
        {
          uri: parsedUri,
          mimeType: "application/json",
          text: JSON.stringify(simulations, null, 2),
        },
      ],
    };
  }

  if (parsedUri === "proxy://server/status") {
    const versionRes = await makeApiRequest({
      method: "GET",
      path: "/api/version",
      userCode,
      managerUrl,
    });
    const statusData = {
      name: "proxy-url",
      version: versionRes.version || packageJson.version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      managerUrl,
    };
    return {
      contents: [
        {
          uri: parsedUri,
          mimeType: "application/json",
          text: JSON.stringify(statusData, null, 2),
        },
      ],
    };
  }

  // Dynamic URI: proxy://simulations/{id}/logs
  const logsMatch = parsedUri.match(/^proxy:\/\/simulations\/([^/]+)\/logs$/);
  if (logsMatch) {
    const simId = logsMatch[1];
    const res = await makeApiRequest({
      method: "GET",
      path: `/api/simulations/${encodeURIComponent(simId)}/logs`,
      userCode,
      managerUrl,
    });
    return {
      contents: [
        {
          uri: parsedUri,
          mimeType: "application/json",
          text: JSON.stringify(res, null, 2),
        },
      ],
    };
  }

  // Dynamic URI: proxy://simulations/{id}
  const simMatch = parsedUri.match(/^proxy:\/\/simulations\/([^/]+)$/);
  if (simMatch) {
    const simId = simMatch[1];
    const simulations = await makeApiRequest({
      method: "GET",
      path: "/api/simulations",
      userCode,
      managerUrl,
    });
    const sim = simulations.find(
      (s) => s.id === simId || String(s.port) === simId
    );
    if (!sim) {
      throw new Error(`Resource '${uri}' not found`);
    }
    return {
      contents: [
        {
          uri: parsedUri,
          mimeType: "application/json",
          text: JSON.stringify(sim, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

module.exports = {
  staticResources,
  resourceTemplates,
  readResource,
};
