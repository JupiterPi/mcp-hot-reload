import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ChildSession } from "./childSession.js";
import { patchCapabilities } from "./capabilities.js";
import { mergeInjectedTool, toolNameSet } from "./toolListDiff.js";
import { buildRestartTool, performRestart, type RestartContext } from "./restartTool.js";
import { InternalIdAllocator } from "./idNamespace.js";
import type { ProxyOptions, RestartOutcome } from "./types.js";
import { logger } from "./logger.js";

interface PendingChildRequest {
  child: ChildSession;
  method: string;
}

/**
 * The router: a front-facing Transport (talking to the real MCP client) wired to
 * whichever ChildSession is currently "active" (talking to the dev server under
 * development). Ordinary requests/notifications are forwarded verbatim in both
 * directions; `tools/list` gets the injected restart tool merged in, and
 * `tools/call` for that tool name is handled entirely inside the proxy.
 */
export class HotReloadProxy {
  private readonly idAllocator = new InternalIdAllocator();
  private activeChild!: ChildSession;
  private initializeReceived = false;
  private capturedInitializeParams: unknown;
  private lastMergedToolNames = new Set<string>();
  private initialSpawnError: Error | undefined;
  private shuttingDown = false;

  /** Front-originated requests currently forwarded to a child, keyed by their original id. */
  private readonly pendingChildRequests = new Map<RequestId, PendingChildRequest>();
  /** Child-originated requests (sampling/roots/elicitation) relayed to front, keyed by the child's id. */
  private readonly pendingServerInitiatedRequests = new Map<RequestId, ChildSession>();

  constructor(
    private readonly options: ProxyOptions,
    private readonly front: Transport,
  ) {}

  async start(): Promise<void> {
    this.activeChild = new ChildSession(this.options.childCommand, this.options.childArgs, this.options.stderrTailLines);
    try {
      await this.activeChild.spawn();
    } catch (error) {
      // Don't crash the proxy process — keep the front connection open so we can
      // reply to the eventual `initialize` call with a clear error instead.
      this.initialSpawnError = error instanceof Error ? error : new Error(String(error));
      logger.error(`failed to launch dev server: ${this.initialSpawnError.message}`);
    }

    this.front.onmessage = (message) => {
      this.handleFrontMessage(message).catch((error: Error) => {
        logger.error(`error handling a message from the client: ${error.message}`);
      });
    };
    this.front.onerror = (error) => {
      logger.warn(`client transport error: ${error.message}`);
    };
    this.front.onclose = () => {
      logger.info("client disconnected; shutting down the dev server");
      this.shuttingDown = true;
      this.activeChild.close().catch(() => {});
    };

    await this.front.start();
  }

  private async handleFrontMessage(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(message)) {
      await this.handleFrontRequest(message);
      return;
    }
    if (isJSONRPCNotification(message)) {
      await this.activeChild.sendNotification(message.method, message.params).catch((error: Error) => {
        logger.warn(`failed to forward notification ${message.method}: ${error.message}`);
      });
      return;
    }
    // Otherwise this is a response/error the front client is sending back to a
    // request that a CHILD originated (sampling/roots/elicitation, etc.).
    if ("id" in message && message.id !== undefined) {
      const child = this.pendingServerInitiatedRequests.get(message.id);
      this.pendingServerInitiatedRequests.delete(message.id);
      if (child) {
        await child.send(message).catch((error: Error) => {
          logger.warn(`failed to relay client response to dev server: ${error.message}`);
        });
      }
    }
  }

  private async handleFrontRequest(request: JSONRPCRequest): Promise<void> {
    if (request.method === "initialize") {
      await this.handleInitialize(request);
      return;
    }
    if (request.method === "tools/call" && isRestartToolCall(request, this.options.toolName)) {
      await this.handleRestartCall(request);
      return;
    }

    const child = this.activeChild;
    this.pendingChildRequests.set(request.id, { child, method: request.method });
    try {
      await child.send(request);
    } catch (error) {
      this.pendingChildRequests.delete(request.id);
      await this.sendFrontError(request.id, ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleInitialize(request: JSONRPCRequest): Promise<void> {
    if (this.initializeReceived) {
      await this.sendFrontError(request.id, ErrorCode.InvalidRequest, "This session has already been initialized.");
      return;
    }
    this.initializeReceived = true;
    this.capturedInitializeParams = request.params;

    if (this.initialSpawnError) {
      await this.sendFrontError(
        request.id,
        ErrorCode.InternalError,
        `The dev server failed to start: ${this.initialSpawnError.message}`,
      );
      return;
    }

    try {
      const initId = this.idAllocator.next();
      const result = (await this.activeChild.sendInternalRequest(
        initId,
        "initialize",
        request.params,
        this.options.restartTimeoutMs,
      )) as { capabilities?: Record<string, unknown>; [key: string]: unknown };
      await this.activeChild.sendNotification("notifications/initialized", {});

      await this.refreshLastMergedToolNames(this.activeChild);
      this.wireActiveChildHandlers(this.activeChild);

      const patched = {
        ...result,
        capabilities: patchCapabilities(result.capabilities ?? {}),
      };
      await this.front.send({ jsonrpc: "2.0", id: request.id, result: patched } as JSONRPCMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`dev server failed to initialize: ${message}`);
      await this.sendFrontError(request.id, ErrorCode.InternalError, `The dev server failed to start: ${message}`);
    }
  }

  /** Best-effort probe so the first restart's tool diff is accurate even if the front client never calls tools/list. */
  private async refreshLastMergedToolNames(child: ChildSession): Promise<void> {
    try {
      const toolsId = this.idAllocator.next();
      const result = (await child.sendInternalRequest(toolsId, "tools/list", {}, this.options.restartTimeoutMs)) as {
        tools?: Tool[];
      };
      const merged = mergeInjectedTool(result.tools ?? [], buildRestartTool(this.options.toolName));
      this.lastMergedToolNames = toolNameSet(merged);
    } catch {
      this.lastMergedToolNames = new Set([this.options.toolName]);
    }
  }

  private async handleRestartCall(request: JSONRPCRequest): Promise<void> {
    const ctx: RestartContext = {
      options: this.options,
      frontSend: (message) => this.front.send(message),
      allocateInternalId: () => this.idAllocator.next(),
      capturedInitializeParams: this.capturedInitializeParams,
      activeChild: this.activeChild,
      lastMergedToolNames: this.lastMergedToolNames,
      setLastMergedToolNames: (names) => {
        this.lastMergedToolNames = names;
      },
      promoteToActive: (child) => this.promoteToActive(child),
      failInFlightRequestsAgainst: (child) =>
        this.failInFlightRequestsAgainst(
          child,
          "The dev server was restarted while this request was in flight; please retry.",
        ),
    };

    const outcome = await performRestart(ctx);
    await this.front.send(buildRestartCallResult(request.id, outcome));
  }

  /** Swaps the active child, moving its message/exit handlers onto the new session and clearing the old one's. */
  private promoteToActive(candidate: ChildSession): void {
    const old = this.activeChild;
    old.onUnhandledMessage = undefined;
    old.onExit = undefined;
    this.activeChild = candidate;
    this.wireActiveChildHandlers(candidate);
  }

  private wireActiveChildHandlers(child: ChildSession): void {
    child.onUnhandledMessage = (message) => this.handleChildMessage(child, message);
    child.onExit = () => this.handleChildUnexpectedExit(child);
  }

  private handleChildMessage(child: ChildSession, message: JSONRPCMessage): void {
    if ("id" in message && message.id !== undefined && this.pendingChildRequests.has(message.id)) {
      const pending = this.pendingChildRequests.get(message.id)!;
      this.pendingChildRequests.delete(message.id);

      if (pending.method === "tools/list" && isJSONRPCResponse(message)) {
        const result = message.result as { tools?: Tool[]; [key: string]: unknown };
        const merged = mergeInjectedTool(result.tools ?? [], buildRestartTool(this.options.toolName));
        this.lastMergedToolNames = toolNameSet(merged);
        const patched = { ...message, result: { ...result, tools: merged } };
        void this.front.send(patched as JSONRPCMessage);
        return;
      }

      void this.front.send(message);
      return;
    }

    if (isJSONRPCNotification(message)) {
      void this.front.send(message);
      return;
    }

    if (isJSONRPCRequest(message)) {
      this.pendingServerInitiatedRequests.set(message.id, child);
      void this.front.send(message);
      return;
    }

    logger.warn(`dev server sent an unexpected message with no matching request: ${JSON.stringify(message)}`);
  }

  private handleChildUnexpectedExit(child: ChildSession): void {
    if (child !== this.activeChild) return; // stale child tearing down after a restart — expected, already unwired.
    if (this.shuttingDown) return; // client disconnected; the whole proxy is tearing down.
    logger.error("the dev server process exited unexpectedly; call the restart tool to bring it back.");
    this.failInFlightRequestsAgainst(
      child,
      "The dev server exited unexpectedly. Call the restart tool to bring it back, then retry.",
    );
  }

  private failInFlightRequestsAgainst(child: ChildSession, message: string): void {
    for (const [id, pending] of this.pendingChildRequests) {
      if (pending.child === child) {
        this.pendingChildRequests.delete(id);
        void this.sendFrontError(id, ErrorCode.ConnectionClosed, message);
      }
    }
    for (const [id, pendingChild] of this.pendingServerInitiatedRequests) {
      if (pendingChild === child) {
        this.pendingServerInitiatedRequests.delete(id);
      }
    }
  }

  private async sendFrontError(id: RequestId, code: ErrorCode, message: string): Promise<void> {
    await this.front.send({ jsonrpc: "2.0", id, error: { code, message } } as JSONRPCMessage);
  }
}

function isRestartToolCall(request: JSONRPCRequest, toolName: string): boolean {
  const params = request.params as { name?: unknown } | undefined;
  return typeof params?.name === "string" && params.name === toolName;
}

function buildRestartCallResult(id: RequestId, outcome: RestartOutcome): JSONRPCMessage {
  if (outcome.ok) {
    const parts: string[] = ["Dev server restarted."];
    if (outcome.addedTools.length > 0) parts.push(`Added tools: ${outcome.addedTools.join(", ")}.`);
    if (outcome.removedTools.length > 0) parts.push(`Removed tools: ${outcome.removedTools.join(", ")}.`);
    if (outcome.addedTools.length === 0 && outcome.removedTools.length === 0) parts.push("Tool list unchanged.");
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: parts.join(" ") }], isError: false },
    } as JSONRPCMessage;
  }

  const text = [`Failed to restart the dev server (${outcome.reason}): ${outcome.message}`, "", "stderr tail:", outcome.stderrTail]
    .join("\n")
    .trim();
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  } as JSONRPCMessage;
}
