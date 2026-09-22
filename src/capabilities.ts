import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * The proxy always offers the restart tool, regardless of what the child declares
 * (including a child that declares no `tools` capability at all), so the relayed
 * `InitializeResult.capabilities` must always advertise tools + listChanged support.
 * Pure — returns a new object, never mutates its input.
 */
export function patchCapabilities(childCapabilities: ServerCapabilities): ServerCapabilities {
  return {
    ...childCapabilities,
    tools: {
      ...childCapabilities.tools,
      listChanged: true,
    },
  };
}
