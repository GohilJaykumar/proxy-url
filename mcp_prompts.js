const promptDefinitions = [
  {
    name: "setup_http_proxy",
    description: "Guided setup for creating an HTTP/RPC proxy simulation",
    arguments: [
      {
        name: "target_url",
        description: "The URL to proxy (e.g. https://api.example.com)",
        required: true,
      },
      {
        name: "rate_limit",
        description: "Max requests per second (default: 15)",
        required: false,
      },
    ],
  },
  {
    name: "setup_websocket_proxy",
    description: "Guided setup for creating a WebSocket proxy simulation",
    arguments: [
      {
        name: "target_url",
        description: "The WebSocket URL to proxy (wss://...)",
        required: true,
      },
    ],
  },
  {
    name: "chaos_test",
    description: "Run a chaos engineering test: create a proxy, verify it works, take it down, verify error handling, bring it back up",
    arguments: [
      {
        name: "target_url",
        description: "The URL to test against",
        required: true,
      },
      {
        name: "url_type",
        description: "Type: http, ws, or db",
        required: true,
      },
    ],
  },
];

function getPrompt(name, args = {}) {
  switch (name) {
    case "setup_http_proxy": {
      if (!args.target_url) {
        throw new Error("Missing required argument: target_url");
      }
      const rateLimit = args.rate_limit ? Number(args.rate_limit) : 15;
      return {
        description: "Prompt to setup an HTTP proxy simulation",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please set up an HTTP proxy simulation for the target URL: ${args.target_url} with a rate limit of ${rateLimit} requests per second using the 'create_simulation' tool.`,
            },
          },
        ],
      };
    }

    case "setup_websocket_proxy": {
      if (!args.target_url) {
        throw new Error("Missing required argument: target_url");
      }
      return {
        description: "Prompt to setup a WebSocket proxy simulation",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please set up a WebSocket proxy simulation for target URL: ${args.target_url} with url_type 'ws' using the 'create_simulation' tool.`,
            },
          },
        ],
      };
    }

    case "chaos_test": {
      if (!args.target_url || !args.url_type) {
        throw new Error("Missing required arguments: target_url and url_type");
      }
      return {
        description: "Guided chaos testing workflow prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please perform a chaos test on ${args.target_url} (type: ${args.url_type}):\n1. Create a new simulation for ${args.target_url} with url_type '${args.url_type}'\n2. Verify the proxy simulation details with 'get_simulation'\n3. Simulate a failure using 'simulation_down'\n4. Verify that requests fail\n5. Restore normal operation using 'simulation_up'`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

module.exports = {
  definitions: promptDefinitions,
  getPrompt,
};
