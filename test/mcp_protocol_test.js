const assert = require("assert");
const { processJsonRpcRequest } = require("../mcp_server");

async function runProtocolTests() {
  console.log("Running MCP Protocol Tests...");

  // Test 1: initialize
  const initRes = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.strictEqual(initRes.jsonrpc, "2.0");
  assert.strictEqual(initRes.id, 1);
  assert.ok(initRes.result.serverInfo);
  assert.strictEqual(initRes.result.serverInfo.name, "proxy-url");
  console.log("✓ initialize test passed");

  // Test 2: ping
  const pingRes = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "ping",
  });
  assert.strictEqual(pingRes.id, 2);
  assert.deepStrictEqual(pingRes.result, {});
  console.log("✓ ping test passed");

  // Test 3: tools/list
  const toolsRes = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
  });
  assert.strictEqual(toolsRes.id, 3);
  assert.ok(Array.isArray(toolsRes.result.tools));
  assert.strictEqual(toolsRes.result.tools.length, 13);
  console.log("✓ tools/list test passed (13 tools defined)");

  // Test 4: resources/list
  const resList = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/list",
  });
  assert.strictEqual(resList.id, 4);
  assert.ok(Array.isArray(resList.result.resources));
  console.log("✓ resources/list test passed");

  // Test 5: prompts/list
  const promptsRes = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "prompts/list",
  });
  assert.strictEqual(promptsRes.id, 5);
  assert.ok(Array.isArray(promptsRes.result.prompts));
  console.log("✓ prompts/list test passed");

  // Test 6: unknown method
  const unknownRes = await processJsonRpcRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "unknown/method",
  });
  assert.strictEqual(unknownRes.id, 6);
  assert.ok(unknownRes.error);
  assert.strictEqual(unknownRes.error.code, -32601);
  console.log("✓ unknown method test passed");

  console.log("\nAll MCP Protocol Tests Passed Successfully!\n");
}

if (require.main === module) {
  runProtocolTests().catch((err) => {
    console.error("MCP Protocol Test Failed:", err);
    process.exit(1);
  });
}

module.exports = { runProtocolTests };
