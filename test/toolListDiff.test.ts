import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { diffToolNames, mergeInjectedTool, toolNameSet } from "../src/toolListDiff.js";

function tool(name: string): Tool {
  return { name, inputSchema: { type: "object", properties: {} } };
}

test("mergeInjectedTool appends without mutating the input array", () => {
  const original = [tool("echo")];
  const merged = mergeInjectedTool(original, tool("restart_dev_server"));

  assert.deepEqual(
    merged.map((t) => t.name),
    ["echo", "restart_dev_server"],
  );
  assert.deepEqual(original.map((t) => t.name), ["echo"]);
});

test("toolNameSet collects tool names", () => {
  const set = toolNameSet([tool("a"), tool("b")]);
  assert.deepEqual([...set].sort(), ["a", "b"]);
});

test("diffToolNames reports additions and removals, ignoring unchanged names", () => {
  const before = new Set(["echo", "restart_dev_server"]);
  const after = new Set(["echo", "search", "restart_dev_server"]);

  const diff = diffToolNames(before, after);

  assert.deepEqual(diff.added, ["search"]);
  assert.deepEqual(diff.removed, []);
});

test("diffToolNames reports a removal", () => {
  const before = new Set(["echo", "search"]);
  const after = new Set(["echo"]);

  const diff = diffToolNames(before, after);

  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, ["search"]);
});

test("diffToolNames on identical sets reports nothing", () => {
  const names = new Set(["echo", "restart_dev_server"]);
  const diff = diffToolNames(names, new Set(names));

  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});
