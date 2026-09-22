import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Appends the proxy's injected tool to a child's tool list. Pure — never mutates its input. */
export function mergeInjectedTool(childTools: Tool[], injected: Tool): Tool[] {
  return [...childTools, injected];
}

export function toolNameSet(tools: Tool[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

export interface ToolNameDiff {
  added: string[];
  removed: string[];
}

/** Pure diff of two tool-name sets, e.g. the merged list before vs. after a restart. */
export function diffToolNames(before: Set<string>, after: Set<string>): ToolNameDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of after) {
    if (!before.has(name)) added.push(name);
  }
  for (const name of before) {
    if (!after.has(name)) removed.push(name);
  }
  return { added, removed };
}
