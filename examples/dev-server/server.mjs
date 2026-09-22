#!/usr/bin/env node
// A tiny example MCP server used for manually (and automatically, via test/e2e.test.ts)
// exercising mcp-hot-reload. Plain Node, no build step. Edit VERSION below and call the
// proxy's restart tool to see the change picked up without reconnecting your MCP client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1";

const server = new McpServer({ name: "mcp-hot-reload-example-dev-server", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: `Echoes the given text back, prefixed with the running server version (currently ${VERSION}).`,
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `[v${VERSION}] ${text}` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
