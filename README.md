# mcp-hot-reload

A transparent MCP stdio proxy for developing MCP servers. Point your MCP client at
`mcp-hot-reload` instead of your server directly, and it forwards everything through to your
server ("the child") unchanged — except it injects one extra tool, `restart_dev_server`. Call
that tool after editing your server's source, and the proxy swaps in a freshly-spawned copy of
it **inside the same client session**, so your updated tools are available immediately without
reconnecting.

There is no file watching. Restart happens only when you (or your agent) explicitly calls the
injected tool.

## Usage

```
mcp-hot-reload [options] -- <command to run your dev-mode MCP server> [args...]
```

Options:

- `--tool-name <name>` — name of the injected restart tool (default: `restart_dev_server`)
- `--restart-timeout-ms <ms>` — timeout for the internal restart handshake (default: `10000`)
- `--stderr-tail-lines <n>` — lines of dev-server stderr kept for failed-restart reports (default: `200`)

Example, wrapping the bundled example server:

```
mcp-hot-reload -- node examples/dev-server/server.mjs
```

### Claude Code configuration

Point Claude Code at the proxy instead of your server directly:

```json
{
  "mcpServers": {
    "my-dev-server": {
      "command": "node",
      "args": [
        "/path/to/mcp-hot-reload/dist/cli.js",
        "--",
        "node",
        "/path/to/my-server/index.js"
      ]
    }
  }
}
```

Once connected, edit `my-server`'s source, then ask the agent to call `restart_dev_server`. The
agent can keep using the same conversation — its next `tools/list` and tool calls will reflect
the updated server.

## How it works

The proxy speaks MCP on both sides: `StdioServerTransport` to the real client, and one
`StdioClientTransport` per dev-server process it manages. Ordinary requests and notifications are
forwarded verbatim in both directions.

Calling `restart_dev_server` triggers a **blue/green swap**:

1. Spawn a *new* child process. The old one keeps running and keeps serving other requests.
2. Perform an internal `initialize`/`initialized` handshake with the new child, replaying the
   exact `protocolVersion`/`capabilities`/`clientInfo` the real client sent when the session
   started.
3. On success: atomically swap the "active child" pointer, fail any requests still in flight
   against the old child with a "please retry" error, send `notifications/tools/list_changed`
   (and the resources/prompts equivalents) to the client, and close the old child.
4. On failure (the edit broke something): the new process is discarded, the old one is never
   touched, and the tool call returns `isError: true` with the captured stderr tail — so a bad
   edit never takes down your working server. Fix it and call the tool again.

This is legitimate under the MCP spec's "exactly one `initialize` per session" rule because that
rule governs the logical session between the real client and *the server* — and from the client's
point of view, the proxy *is* the server. What the proxy does internally to the process backing
that identity is invisible implementation detail, the same way a connection pool can silently
re-establish a dropped backend connection.

If the currently-active child crashes on its own (not via the restart tool), the proxy does not
auto-respawn it — that's a different feature from "manual restart only." It fails in-flight
requests with a clear error telling you to call the restart tool.

## Development

```
npm install
npm run build   # compile src/ -> dist/
npm test        # unit tests + an end-to-end test driving the built CLI
```

Manual end-to-end check with the MCP Inspector:

```
npx @modelcontextprotocol/inspector node dist/cli.js -- node examples/dev-server/server.mjs
```

Call `tools/list` and `echo`, edit the `VERSION` constant in
`examples/dev-server/server.mjs` while Inspector stays connected, call
`restart_dev_server`, then call `tools/list`/`echo` again — the version bump should be visible
without reconnecting Inspector.
