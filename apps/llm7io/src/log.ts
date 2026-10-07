// ── Lightweight namespaced logger for LLM7.io ──────────────────────
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export function createLog(baseContext: LogContext = {}) {
  return (level: LogLevel, msg: string, extra: LogContext = {}) => {
    const timestamp = new Date().toISOString();
    const ctx = { ...baseContext, ...extra };
    const ctxStr = Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
    const prefix = `[${timestamp}] [llm7io] [${level.toUpperCase()}]`;

    if (level === "error") {
      console.error(`${prefix} ${msg}${ctxStr}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${msg}${ctxStr}`);
    } else {
      console.log(`${prefix} ${msg}${ctxStr}`);
    }
  };
}
