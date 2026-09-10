// ── Minimal structured logger ──────────────────────────────────────
export type LogLevel = "info" | "warn" | "error";

export interface ULog {
  (level: LogLevel, msg: string, meta?: Record<string, unknown>): void;
  child: (meta?: Record<string, unknown>) => ULog;
}

export function createLog(base: Record<string, unknown> = {}): ULog {
  const fn = ((level: LogLevel, msg: string, meta: Record<string, unknown> = {}) => {
    const line = { ts: new Date().toISOString(), level, ...base, ...meta, msg };
    if (level === "error") console.error(JSON.stringify(line));
    else console.log(JSON.stringify(line));
  }) as ULog;
  fn.child = (meta = {}) => createLog({ ...base, ...meta });
  return fn;
}