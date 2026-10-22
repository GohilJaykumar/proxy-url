const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const mcpTools = require("../mcp_tools");
const mcpResources = require("../mcp_resources");

let managerProcess = null;
const DEFAULT_PORT = process.env.MANAGER_PORT || 9090;
let MANAGER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
let userCode = null;

function checkServerAvailable(url) {
  return new Promise((resolve) => {
    http.get(`${url}/api/version`, (res) => {
      resolve(res.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http
        .get(`${url}/api/version`, (res) => {
          if (res.statusCode === 200) resolve();
          else if (Date.now() - start > timeoutMs) reject(new Error("Server startup timeout"));
          else setTimeout(check, 150);
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("Server startup timeout"));
          else setTimeout(check, 150);
        });
    }
    check();
  });
}

async function runToolsTests() {
  const isAlreadyRunning = await checkServerAvailable(MANAGER_URL);
  if (!isAlreadyRunning) {
    const TEST_PORT = 9988;
    MANAGER_URL = `http://127.0.0.1:${TEST_PORT}`;
    console.log(`Starting manager server for MCP tools test on port ${TEST_PORT}...`);
    managerProcess = spawn("node", ["manager_server.js"], {
      cwd: __dirname + "/..",
      env: { ...process.env, MANAGER_PORT: String(TEST_PORT) },
      stdio: "inherit",
    });

    await waitForServer(MANAGER_URL);
  }
  console.log(`Manager server connected at ${MANAGER_URL}`);

  // Fetch a user code
  const sessionRes = await mcpTools.makeApiRequest({
    method: "GET",
    path: "/api/session",
    managerUrl: MANAGER_URL,
  });
  userCode = sessionRes.user_code;
  assert.ok(userCode, "User code should be issued");

  console.log("Running MCP Tools Integration Tests...");

  // 1. suggest_port
  const suggestRes = await mcpTools.execute("suggest_port", {}, { userCode, managerUrl: MANAGER_URL });
  assert.ok(suggestRes.content[0].text.includes("Suggested free port"));
  console.log("✓ suggest_port tool test passed");

  // 2. check_port
  const checkRes = await mcpTools.execute("check_port", { port: 5123 }, { userCode, managerUrl: MANAGER_URL });
  assert.ok(checkRes.content[0].text.includes("available"));
  console.log("✓ check_port tool test passed");

  // 3. create_simulation (HTTP)
  const createRes = await mcpTools.execute(
    "create_simulation",
    {
      simulate_url: "https://httpbin.org/get",
      url_type: "http",
      name: "mcp-test-sim",
      port: 5123,
    },
    { userCode, managerUrl: MANAGER_URL }
  );
  assert.ok(createRes.content[0].text.includes("Successfully created simulation"));
  console.log("✓ create_simulation tool test passed");

  // 4. list_simulations
  const listRes = await mcpTools.execute("list_simulations", {}, { userCode, managerUrl: MANAGER_URL });
  const listJson = JSON.parse(listRes.content[0].text);
  assert.strictEqual(listJson.length, 1);
  assert.strictEqual(listJson[0].port, 5123);
  console.log("✓ list_simulations tool test passed");

  // 5. get_simulation
  const getRes = await mcpTools.execute("get_simulation", { port: 5123 }, { userCode, managerUrl: MANAGER_URL });
  const getJson = JSON.parse(getRes.content[0].text);
  assert.strictEqual(getJson.port, 5123);
  console.log("✓ get_simulation tool test passed");

  // 6. simulation_down
  const downRes = await mcpTools.execute("simulation_down", { port: 5123 }, { userCode, managerUrl: MANAGER_URL });
  assert.ok(downRes.content[0].text.includes("is now DOWN"));
  console.log("✓ simulation_down tool test passed");

  // 7. simulation_up
  const upRes = await mcpTools.execute("simulation_up", { port: 5123 }, { userCode, managerUrl: MANAGER_URL });
  assert.ok(upRes.content[0].text.includes("is now UP"));
  console.log("✓ simulation_up tool test passed");

  // 8. rename_simulation
  const renameRes = await mcpTools.execute(
    "rename_simulation",
    { port: 5123, name: "mcp-renamed-sim" },
    { userCode, managerUrl: MANAGER_URL }
  );
  assert.ok(renameRes.content[0].text.includes("mcp-renamed-sim"));
  console.log("✓ rename_simulation tool test passed");

  // 9. clone_simulation
  const cloneRes = await mcpTools.execute(
    "clone_simulation",
    { port: 5123, name: "mcp-cloned-sim" },
    { userCode, managerUrl: MANAGER_URL }
  );
  assert.ok(cloneRes.content[0].text.includes("Successfully cloned simulation"));
  console.log("✓ clone_simulation tool test passed");

  // 10. bulk_status_change
  const bulkRes = await mcpTools.execute(
    "bulk_status_change",
    { ports: ["all"], action: "down" },
    { userCode, managerUrl: MANAGER_URL }
  );
  assert.ok(bulkRes.content[0].text.includes("Updated 2 simulation(s) to DOWN"));
  console.log("✓ bulk_status_change tool test passed");

  // 11. get_simulation_logs
  const logsRes = await mcpTools.execute(
    "get_simulation_logs",
    { port: 5123, limit: 10 },
    { userCode, managerUrl: MANAGER_URL }
  );
  assert.ok(logsRes.content[0].text.length > 0);
  console.log("✓ get_simulation_logs tool test passed");

  // 12. delete_simulation
  const deleteRes = await mcpTools.execute("delete_simulation", { port: 5123 }, { userCode, managerUrl: MANAGER_URL });
  assert.ok(deleteRes.content[0].text.includes("successfully deleted"));
  console.log("✓ delete_simulation tool test passed");

  // 13. delete_all_stopped
  const deleteStoppedRes = await mcpTools.execute("delete_all_stopped", {}, { userCode, managerUrl: MANAGER_URL });
  assert.ok(deleteStoppedRes.content[0].text.includes("Deleted"));
  console.log("✓ delete_all_stopped tool test passed");

  // 14. Read resources test
  const resData = await mcpResources.readResource("proxy://server/status", { userCode, managerUrl: MANAGER_URL });
  assert.ok(resData.contents[0].text.includes("proxy-url"));
  console.log("✓ readResource proxy://server/status test passed");

  console.log("\nAll 13 MCP Tools Integration Tests Passed Successfully!\n");
}

async function cleanup() {
  if (managerProcess && !managerProcess.killed) {
    managerProcess.kill("SIGTERM");
  }
}

if (require.main === module) {
  runToolsTests()
    .then(() => cleanup())
    .catch((err) => {
      console.error("MCP Tools Test Failed:", err);
      cleanup();
      process.exit(1);
    });
}
