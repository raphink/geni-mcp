#!/usr/bin/env node
/**
 * MCP Server Integration Test
 * Sends JSON-RPC requests to the MCP server via stdio
 */

import { spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { resolve } from "path";

const SERVER_PATH = resolve(process.cwd(), "dist", "index.js");
const ENV = {
  ...process.env,
  GENI_CLIENT_ID: process.env.GENI_CLIENT_ID || "test_id",
  GENI_CLIENT_SECRET: process.env.GENI_CLIENT_SECRET || "test_secret",
  GENI_ACCESS_TOKEN: process.env.GENI_ACCESS_TOKEN || "test_token",
  GENI_REDIRECT_URI: "http://localhost:3000/oauth/callback",
};

class MCPClient {
  constructor() {
    this.server = null;
    this.requestId = 0;
    this.responses = new Map();
    this.buffer = "";
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = spawn("node", [SERVER_PATH], {
        env: ENV,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Collect stderr for logging
      this.server.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("Geni MCP server running")) {
          console.error("[SERVER]", msg);
        }
      });

      // Handle stdout
      this.server.stdout.on("data", (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.server.on("error", reject);
      this.server.on("close", (code) => {
        if (code !== 0) console.error(`Server exited with code ${code}`);
      });

      // Give server time to start
      setTimeout(resolve, 500);
    });
  }

  processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines[lines.length - 1]; // Keep incomplete line

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          this.responses.set(msg.id, msg);
        }
      } catch (err) {
        console.error("Parse error:", line);
      }
    }
  }

  sendRequest(method, params = {}) {
    const id = ++this.requestId;
    const request = { jsonrpc: "2.0", id, method, params };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Request ${id} timed out after 5s`));
      }, 5000);

      const checkResponse = () => {
        if (this.responses.has(id)) {
          clearTimeout(timeout);
          const response = this.responses.get(id);
          this.responses.delete(id);
          resolve(response);
        } else {
          setTimeout(checkResponse, 10);
        }
      };

      this.server.stdin.write(JSON.stringify(request) + "\n", (err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
        } else {
          checkResponse();
        }
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.kill();
        this.server.on("close", resolve);
      } else {
        resolve();
      }
    });
  }
}

async function runTests() {
  const client = new MCPClient();

  try {
    console.log("Starting MCP server...\n");
    await client.start();

    // Test 1: Initialize
    console.log("📋 Test 1: Initialize");
    try {
      const initResponse = await client.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      });
      console.log(
        `  ✓ Initialize: ${initResponse.result ? "SUCCESS" : "FAILED"}`
      );
      if (initResponse.error) console.error(`  Error: ${initResponse.error.message}`);
    } catch (err) {
      console.error(`  ✗ Initialize failed: ${err.message}`);
    }

    // Test 2: List tools
    console.log("\n📋 Test 2: List Tools");
    try {
      const toolsResponse = await client.sendRequest("tools/list", {});
      if (toolsResponse.result?.tools) {
        console.log(`  ✓ Found ${toolsResponse.result.tools.length} tools:`);
        toolsResponse.result.tools.forEach((tool) => {
          console.log(`    - ${tool.name}`);
        });
      } else {
        console.log(`  ✗ No tools returned`);
        if (toolsResponse.error) console.error(`    Error: ${toolsResponse.error.message}`);
      }
    } catch (err) {
      console.error(`  ✗ List tools failed: ${err.message}`);
    }

    // Test 3: Call get_authorization_url
    console.log("\n📋 Test 3: Call get_authorization_url");
    try {
      const authResponse = await client.sendRequest("tools/call", {
        name: "get_authorization_url",
        arguments: {},
      });
      if (authResponse.result?.content) {
        const content = authResponse.result.content[0]?.text || "";
        console.log(`  ✓ Authorization URL generated`);
        console.log(`    Text length: ${content.length} chars`);
        if (content.includes("https://www.geni.com/oauth/authorize")) {
          console.log(`    ✓ Contains valid OAuth URL`);
        }
      } else {
        console.log(`  ✗ No content returned`);
        if (authResponse.error) console.error(`    Error: ${authResponse.error.message}`);
      }
    } catch (err) {
      console.error(`  ✗ get_authorization_url failed: ${err.message}`);
    }

    // Test 4: Call get_my_profile (will fail without real token, but tests API flow)
    console.log("\n📋 Test 4: Call get_my_profile (API validation test)");
    try {
      const profileResponse = await client.sendRequest("tools/call", {
        name: "get_my_profile",
        arguments: {},
      });
      if (profileResponse.result?.content) {
        const content = profileResponse.result.content[0]?.text || "";
        console.log(`  ✓ Tool executed (response length: ${content.length})`);
        if (profileResponse.result.isError) {
          console.log(`    Note: Returned error (expected with test token)`);
          console.log(`    Message: ${content.substring(0, 100)}...`);
        }
      } else if (profileResponse.error) {
        console.log(`  ! RPC Error: ${profileResponse.error.message}`);
      }
    } catch (err) {
      console.error(`  ✗ get_my_profile request failed: ${err.message}`);
    }

    // Test 5: Test unknown tool
    console.log("\n📋 Test 5: Call unknown tool (error handling)");
    try {
      const unknownResponse = await client.sendRequest("tools/call", {
        name: "nonexistent_tool",
        arguments: {},
      });
      if (unknownResponse.result?.isError) {
        console.log(`  ✓ Correctly handled unknown tool`);
        console.log(`    Message: ${unknownResponse.result.content[0].text}`);
      } else {
        console.log(`  ✗ Should have returned error for unknown tool`);
      }
    } catch (err) {
      console.error(`  ✗ Unknown tool test failed: ${err.message}`);
    }

    console.log("\n✅ All tests completed\n");
  } catch (err) {
    console.error("Test suite error:", err);
  } finally {
    await client.stop();
  }
}

runTests();
