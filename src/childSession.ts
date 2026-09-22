import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  isJSONRPCErrorResponse,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { RingBuffer } from "./ringBuffer.js";
import { logger } from "./logger.js";

interface PendingInternal {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Owns exactly one dev-server child process: its StdioClientTransport, stderr
 * capture, and a request/response correlation layer for requests the proxy
 * itself originates against this child (the initialize handshake, the
 * post-handshake tools/list probe). Any message that isn't a reply to one of
 * those internal requests bubbles up via `onUnhandledMessage`, which the proxy
 * wires up once (and only once) this session becomes the *active* child.
 */
export class ChildSession {
  private readonly transport: StdioClientTransport;
  private readonly stderrRing: RingBuffer;
  private readonly pendingInternal = new Map<RequestId, PendingInternal>();
  private closed = false;

  onUnhandledMessage?: (message: JSONRPCMessage) => void;
  /** Fired when the underlying process exits, whether expectedly (during close()) or not. */
  onExit?: () => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    stderrTailLines: number,
  ) {
    this.transport = new StdioClientTransport({ command, args, stderr: "pipe" });
    this.stderrRing = new RingBuffer(stderrTailLines);

    // Attach stderr listeners immediately (before start()) so early crash output isn't lost.
    const stderrStream = this.transport.stderr;
    if (stderrStream) {
      const rl = createInterface({ input: stderrStream as unknown as Readable });
      rl.on("line", (line) => {
        this.stderrRing.push(line);
        process.stderr.write(`[child] ${line}\n`);
      });
    }

    this.transport.onmessage = (message) => this.handleMessage(message);
    this.transport.onerror = (error) => {
      logger.warn(`dev server transport error (${this.command}): ${error.message}`);
    };
    this.transport.onclose = () => {
      this.closed = true;
      const exitError = new Error("The dev server process exited before responding.");
      for (const pending of this.pendingInternal.values()) {
        pending.reject(exitError);
      }
      this.pendingInternal.clear();
      this.onExit?.();
    };
  }

  /** Spawns the process. Rejects if the command can't even be launched (e.g. ENOENT). */
  spawn(): Promise<void> {
    return this.transport.start();
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  stderrTail(): string {
    return this.stderrRing.tail();
  }

  private handleMessage(message: JSONRPCMessage): void {
    if ("id" in message && message.id !== undefined && this.pendingInternal.has(message.id)) {
      const id = message.id;
      const pending = this.pendingInternal.get(id)!;
      this.pendingInternal.delete(id);
      if (isJSONRPCErrorResponse(message)) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else if ("result" in message) {
        pending.resolve(message.result);
      }
      return;
    }
    this.onUnhandledMessage?.(message);
  }

  /** Sends a request the proxy itself originates against this child, and awaits its reply. */
  sendInternalRequest(id: RequestId, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("The dev server process has already exited."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInternal.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a response to ${method}.`));
      }, timeoutMs);
      this.pendingInternal.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch((error: Error) => {
        clearTimeout(timer);
        this.pendingInternal.delete(id);
        reject(error);
      });
    });
  }

  sendNotification(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params } as JSONRPCMessage);
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.transport.send(message);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
