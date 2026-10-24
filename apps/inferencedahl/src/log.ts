export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ULog {
  (level: LogLevel, msg: string, extra?: Record<string, unknown>): void;
}

export function createLog(baseFields: Record<string, unknown> = {}): ULog {
  return (level: LogLevel, msg: string, extra: Record<string, unknown> = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      ...baseFields,
      ...extra,
      msg,
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };
}
