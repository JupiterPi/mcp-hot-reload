/**
 * Allocates request ids the proxy uses for its own internal MCP calls against a
 * child (the restart handshake, the post-handshake tools/list probe, future health
 * checks). Prefixed so they can never collide with ids the real front-end client
 * chose for its own requests, which are otherwise forwarded to children unchanged.
 */
export class InternalIdAllocator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `__mcp-hot-reload:internal:${this.counter}`;
  }

  static isInternal(id: unknown): id is string {
    return typeof id === "string" && id.startsWith("__mcp-hot-reload:internal:");
  }
}
