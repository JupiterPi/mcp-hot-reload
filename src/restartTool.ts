import type { JSONRPCMessage, RequestId, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChildSession } from "./childSession.js";
import { diffToolNames, mergeInjectedTool, toolNameSet } from "./toolListDiff.js";
import type { ProxyOptions, RestartOutcome } from "./types.js";
import { logger } from "./logger.js";

export function buildRestartTool(name: string): Tool {
  return {
    name,
    description:
      "Restarts the in-development MCP server process managed by mcp-hot-reload, picking up its " +
      "latest source code, and refreshes this session's tool list. Provided by the mcp-hot-reload " +
      "proxy itself, not by the wrapped server. Call this after editing the wrapped server's source " +
      "and before using its updated tools. Safe to call at any time; other tool calls made " +
      "concurrently with this one may fail and should simply be retried after it completes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

/** Everything performRestart needs from the proxy's live state, without depending on proxy.ts itself. */
export interface RestartContext {
  options: ProxyOptions;
  frontSend(message: JSONRPCMessage): Promise<void>;
  allocateInternalId(): RequestId;
  capturedInitializeParams: unknown;
  activeChild: ChildSession;
  lastMergedToolNames: Set<string>;
  setLastMergedToolNames(names: Set<string>): void;
  /** Replaces the active child and wires its message/exit handlers as "the" active session. */
  promoteToActive(child: ChildSession): void;
  /** Sends a synthetic error to front for every request still in flight against this (now-dead) child. */
  failInFlightRequestsAgainst(child: ChildSession): void;
}

export async function performRestart(ctx: RestartContext): Promise<RestartOutcome> {
  const { options } = ctx;
  const candidate = new ChildSession(options.childCommand, options.childArgs, options.stderrTailLines);

  try {
    await candidate.spawn();
  } catch (error) {
    return {
      ok: false,
      reason: "spawn-error",
      message: error instanceof Error ? error.message : String(error),
      stderrTail: candidate.stderrTail(),
    };
  }

  try {
    const initId = ctx.allocateInternalId();
    await candidate.sendInternalRequest(initId, "initialize", ctx.capturedInitializeParams, options.restartTimeoutMs);
    await candidate.sendNotification("notifications/initialized", {});
  } catch (error) {
    await candidate.close().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: message.toLowerCase().includes("timed out") ? "timeout" : "handshake-error",
      message,
      stderrTail: candidate.stderrTail(),
    };
  }

  let candidateTools: Tool[] = [];
  try {
    const toolsId = ctx.allocateInternalId();
    const result = (await candidate.sendInternalRequest(toolsId, "tools/list", {}, options.restartTimeoutMs)) as {
      tools?: Tool[];
    };
    candidateTools = result.tools ?? [];
  } catch {
    // Child has no tools capability (or tools/list otherwise failed) — that's fine, it just has none.
    candidateTools = [];
  }

  const mergedNames = toolNameSet(mergeInjectedTool(candidateTools, buildRestartTool(options.toolName)));
  const diff = diffToolNames(ctx.lastMergedToolNames, mergedNames);

  // ---- atomic swap point: everything after this targets `candidate` ----
  const oldChild = ctx.activeChild;
  ctx.promoteToActive(candidate);
  ctx.failInFlightRequestsAgainst(oldChild);

  await ctx.frontSend({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as JSONRPCMessage);
  await ctx.frontSend({ jsonrpc: "2.0", method: "notifications/resources/list_changed" } as JSONRPCMessage);
  await ctx.frontSend({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" } as JSONRPCMessage);

  oldChild.close().catch((error: Error) => {
    logger.warn(`error closing previous dev server process: ${error.message}`);
  });

  return { ok: true, addedTools: diff.added, removedTools: diff.removed };
}
