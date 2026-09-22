#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HotReloadProxy } from "./proxy.js";
import type { ProxyOptions } from "./types.js";
import { logger } from "./logger.js";

const USAGE = `Usage: mcp-hot-reload [options] -- <command to run the dev-mode MCP server> [args...]

Options:
  --tool-name <name>          Name of the injected restart tool (default: restart_dev_server)
  --restart-timeout-ms <ms>   Timeout for the internal restart handshake (default: 10000)
  --stderr-tail-lines <n>     Lines of dev-server stderr kept for failed-restart reports (default: 200)
  -h, --help                  Show this message

Example:
  mcp-hot-reload -- node examples/dev-server/server.mjs`;

function parseArgs(argv: string[]): ProxyOptions {
  let toolName = "restart_dev_server";
  let restartTimeoutMs = 10_000;
  let stderrTailLines = 200;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--tool-name") {
      toolName = requireValue(argv, i, arg);
      i += 2;
      continue;
    }
    if (arg === "--restart-timeout-ms") {
      restartTimeoutMs = requireIntValue(argv, i, arg);
      i += 2;
      continue;
    }
    if (arg === "--stderr-tail-lines") {
      stderrTailLines = requireIntValue(argv, i, arg);
      i += 2;
      continue;
    }
    fail(`Unrecognized option "${arg}" before "--".\n\n${USAGE}`);
  }

  const childCommand = argv[i];
  const childArgs = argv.slice(i + 1);
  if (!childCommand) {
    fail(`Missing child command after "--".\n\n${USAGE}`);
  }

  return { childCommand: childCommand!, childArgs, toolName, restartTimeoutMs, stderrTailLines };
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) fail(`"${flag}" requires a value.`);
  return value!;
}

function requireIntValue(argv: string[], i: number, flag: string): number {
  const raw = requireValue(argv, i, flag);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) fail(`"${flag}" expects a positive integer, got "${raw}".`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const front = new StdioServerTransport();
  const proxy = new HotReloadProxy(options, front);
  await proxy.start();
  logger.info(`proxying to: ${options.childCommand} ${options.childArgs.join(" ")}`);
}

main().catch((error: Error) => {
  logger.error(`fatal: ${error.message}`);
  process.exit(1);
});
