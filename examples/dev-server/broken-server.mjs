#!/usr/bin/env node
// Simulates a dev-server edit that broke the process. Used by test/e2e.test.ts to exercise
// the restart tool's failure path: prints to stderr, then exits before ever speaking MCP.
console.error("broken-server: simulated startup crash");
process.exit(1);
