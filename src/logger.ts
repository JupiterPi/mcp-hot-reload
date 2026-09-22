/** Diagnostic logging for the proxy itself. Always stderr — stdout is reserved for the MCP channel to the front client. */
export const logger = {
  info(message: string): void {
    process.stderr.write(`[mcp-hot-reload] ${message}\n`);
  },
  warn(message: string): void {
    process.stderr.write(`[mcp-hot-reload] warn: ${message}\n`);
  },
  error(message: string): void {
    process.stderr.write(`[mcp-hot-reload] error: ${message}\n`);
  },
};
