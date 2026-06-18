#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
  cwd: new URL("..", import.meta.url).pathname
});

const client = new Client({
  name: "hpx-viewer-smoke",
  version: "0.1.0"
});

await client.connect(transport);
const tools = await client.listTools();
const toolNames = tools.tools.map((tool) => tool.name);
for (const expected of ["list_datasets", "open_view", "inspect_point", "capture_screenshot", "make_tiles_from_healpix"]) {
  if (!toolNames.includes(expected)) {
    throw new Error(`Missing MCP tool: ${expected}`);
  }
}
const result = await client.callTool({ name: "list_datasets", arguments: {} });
const text = result.content?.[0]?.text ?? "";
const parsed = JSON.parse(text);
if (!Array.isArray(parsed.datasets)) {
  throw new Error("Smoke check did not return a datasets array.");
}
await client.close();
console.log("mcp smoke passed");
