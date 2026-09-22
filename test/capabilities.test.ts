import assert from "node:assert/strict";
import { test } from "node:test";
import { patchCapabilities } from "../src/capabilities.js";

test("forces tools.listChanged even when the child declares no tools capability", () => {
  const patched = patchCapabilities({});
  assert.equal(patched.tools?.listChanged, true);
});

test("preserves other capabilities and other tools-capability fields untouched", () => {
  const patched = patchCapabilities({
    resources: { subscribe: true },
    tools: { listChanged: false },
  });

  assert.deepEqual(patched.resources, { subscribe: true });
  assert.equal(patched.tools?.listChanged, true);
});

test("does not mutate its input", () => {
  const input = { tools: { listChanged: false } };
  patchCapabilities(input);
  assert.equal(input.tools.listChanged, false);
});
