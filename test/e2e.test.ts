import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");
const goodServerPath = path.join(repoRoot, "examples", "dev-server", "server.mjs");
const brokenServerPath = path.join(repoRoot, "examples", "dev-server", "broken-server.mjs");

function goodServerSource(version: string): string {
  return `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "e2e-fixture", version: "0.1.0" });
server.registerTool(
  "echo",
  { description: "echoes text", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: "[v${version}] " + text }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

const BROKEN_SERVER_SOURCE = `
console.error("e2e-fixture: simulated startup crash after edit");
process.exit(1);
`;

/** A minimal raw JSON-RPC client speaking newline-delimited JSON over a child process's stdio. */
class RawClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly stderrChunks: string[] = [];
  private readonly pending = new Map<number, (message: any) => void>();
  private nextId = 1;

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        resolve(message);
      }
    });
    this.proc.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk.toString()));
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for a response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(): Promise<any> {
    const response = await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-hot-reload-e2e-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return response;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 3000);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

test("happy path: initialize, tools/list injection, echo, and a no-op restart", async () => {
  const client = new RawClient("node", [cliPath, "--", "node", goodServerPath]);
  try {
    const initResponse = await client.initialize();
    assert.equal(initResponse.result.capabilities.tools.listChanged, true);

    const toolsBefore = await client.request("tools/list");
    const namesBefore = toolsBefore.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(namesBefore, ["echo", "restart_dev_server"]);

    const echoResponse = await client.request("tools/call", { name: "echo", arguments: { text: "hi" } });
    assert.equal(echoResponse.result.content[0].text, "[v1] hi");

    const restartResponse = await client.request("tools/call", { name: "restart_dev_server", arguments: {} });
    assert.equal(restartResponse.result.isError, false);
    assert.match(restartResponse.result.content[0].text, /unchanged/i);

    const toolsAfter = await client.request("tools/list");
    const namesAfter = toolsAfter.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(namesAfter, ["echo", "restart_dev_server"]);

    const echoAfter = await client.request("tools/call", { name: "echo", arguments: { text: "still here" } });
    assert.equal(echoAfter.result.content[0].text, "[v1] still here");
  } finally {
    await client.close();
  }
});

test("initial spawn/handshake failure is reported without crashing the proxy", async () => {
  const client = new RawClient("node", [cliPath, "--", "node", brokenServerPath]);
  try {
    const initResponse = await client.initialize();
    assert.ok(initResponse.error, "expected an error response for the initialize call");
    assert.match(initResponse.error.message, /dev server failed to start/i);
  } finally {
    await client.close();
  }
});

test("a broken restart candidate leaves the old dev server running; a subsequent good restart recovers", async () => {
  // Nested inside the repo (not os.tmpdir()) so Node's ESM resolver can still find
  // node_modules/@modelcontextprotocol/sdk by walking up from the fixture file.
  const tmpRoot = path.join(repoRoot, "test", ".tmp-e2e");
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tmpRoot, "run-"));
  const targetPath = path.join(dir, "target.mjs");
  await writeFile(targetPath, goodServerSource("1"));

  const client = new RawClient("node", [cliPath, "--", "node", targetPath]);
  try {
    await client.initialize();

    const echoBefore = await client.request("tools/call", { name: "echo", arguments: { text: "before" } });
    assert.equal(echoBefore.result.content[0].text, "[v1] before");

    // Simulate an edit that breaks the dev server, then trigger a restart.
    await writeFile(targetPath, BROKEN_SERVER_SOURCE);
    const failedRestart = await client.request("tools/call", { name: "restart_dev_server", arguments: {} }, 20_000);
    assert.equal(failedRestart.result.isError, true);
    assert.match(failedRestart.result.content[0].text, /stderr tail/i);

    // The old (still-good) child must still be serving requests.
    const echoAfterFailure = await client.request("tools/call", { name: "echo", arguments: { text: "still good" } });
    assert.equal(echoAfterFailure.result.content[0].text, "[v1] still good");

    // Fix the edit and restart again — this time it should succeed.
    await writeFile(targetPath, goodServerSource("2"));
    const recoveredRestart = await client.request("tools/call", { name: "restart_dev_server", arguments: {} }, 20_000);
    assert.equal(recoveredRestart.result.isError, false);

    const echoAfterRecovery = await client.request("tools/call", { name: "echo", arguments: { text: "recovered" } });
    assert.equal(echoAfterRecovery.result.content[0].text, "[v2] recovered");
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
