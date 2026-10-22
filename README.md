# Proxy URL Simulation Manager

A proxy simulation manager allowing developers and AI assistants to create, break, fix, throttle, and monitor proxy simulations for HTTP, WebSocket, and Database (TCP) upstreams.

---

## Prerequisites

- Node.js 18+ (Node 20+ recommended)
- npm
- Docker (optional)

---

## Quick Start

```bash
# Install dependencies
npm install

# Start manager server
npm run start
```

Manager UI & REST API: `http://localhost:9090`
Documentation: `http://localhost:9090/docs.html`

---

## Model Context Protocol (MCP) Server Integration

The Proxy URL Simulation Manager includes full **Model Context Protocol (MCP)** server support, allowing AI assistants (Claude Desktop, Cursor IDE, VS Code Copilot) to directly manage simulations via natural language.

### MCP Transports

| Transport | Endpoint / Command | Use Case |
|-----------|--------------------|----------|
| **Streamable HTTP** | `POST http://localhost:9090/mcp` | Remote/hosted server deployments |
| **stdio** | `npm run mcp:stdio` or `node mcp_server.js --stdio` | Local sub-process execution |

### Client Configuration Examples

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "proxy-url": {
      "url": "http://localhost:9090/mcp",
      "transport": "streamable-http",
      "headers": {
        "x-user-code": "YOUR_SIM_CODE_HERE"
      }
    }
  }
}
```

#### Cursor IDE (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "proxy-url": {
      "url": "http://localhost:9090/mcp",
      "transport": "streamable-http",
      "headers": {
        "x-user-code": "YOUR_SIM_CODE_HERE"
      }
    }
  }
}
```

#### Local stdio Mode
```json
{
  "mcpServers": {
    "proxy-url": {
      "command": "node",
      "args": ["/path/to/proxy-url/mcp_server.js", "--stdio"],
      "env": {
        "MANAGER_PORT": "9090",
        "SIM_CODE": "YOUR_SIM_CODE_HERE"
      }
    }
  }
}
```

> **IMPORTANT:** Copy your `SIM_CODE` from the profile icon in the top-right corner of the web dashboard.

---

## Available MCP Executable Tools (13 Tools)

1. `create_simulation` — Create an HTTP, WebSocket, or DB proxy simulation.
2. `list_simulations` — List all simulations owned by your Sim-Code.
3. `get_simulation` — Get detailed metadata for a specific simulation by port.
4. `simulation_down` — Simulate an outage by port (reject traffic with error code).
5. `simulation_up` — Restore a simulation back to UP state by port.
6. `delete_simulation` — Delete a simulation by port and free the port.
7. `rename_simulation` — Rename an existing simulation by port.
8. `get_simulation_logs` — Retrieve up to 300 recent log entries by port.
9. `check_port` — Check if a specific port number is free.
10. `suggest_port` — Get the next free available port.
11. `delete_all_stopped` — Clean up all stopped simulations owned by your Sim-Code.
12. `clone_simulation` — Duplicate a simulation by port with optional parameter overrides.
13. `bulk_status_change` — Set multiple simulations UP or DOWN simultaneously by port.

---

## MCP Context Resources & Prompts

### Resources (Read-Only Context)
- `proxy://simulations` — Active simulations list
- `proxy://simulations/{id}` — Simulation details
- `proxy://simulations/{id}/logs` — Simulation log buffer
- `proxy://server/status` — Server health, uptime, and metadata

### Prompts
- `setup_http_proxy` — Guided prompt template for HTTP proxy creation
- `setup_websocket_proxy` — Guided prompt template for WS proxy creation
- `chaos_test` — Guided chaos engineering workflow template

---

## Core System Limitations & Rules

- **Simulation Lifetime:** Maximum **24 hours lifetime** or **3 hours idle** without traffic.
- **Port Addressing:** Port numbers must be integers in range `1000`–`65535`.
- **Throughput Limits:** Default 15 req/s (configurable via `max_requests_per_second` up to 1000 req/s).
- **Workspace Scoping:** All actions require a valid `Sim-Code` (`x-user-code` header or `SIM_CODE` env variable).

---

## Running Automated Tests

```bash
npm test
```

Executes `test/mcp_protocol_test.js` and `test/mcp_tools_test.js`.

---

## Docker Support

```bash
# Build image
docker build -t proxy-url .

# Run container
docker run -d --name proxy-url -p 9090:9090 proxy-url
```
