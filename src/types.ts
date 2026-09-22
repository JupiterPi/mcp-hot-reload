export interface ProxyOptions {
  childCommand: string;
  childArgs: string[];
  toolName: string;
  restartTimeoutMs: number;
  stderrTailLines: number;
}

export type RestartOutcome =
  | { ok: true; addedTools: string[]; removedTools: string[] }
  | { ok: false; reason: "spawn-error" | "timeout" | "handshake-error"; message: string; stderrTail: string };
