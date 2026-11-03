export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogContext {
  workerId?: number;
  email?: string;
  step?: string;
  cli?: string;
}

export function createLog(context: LogContext = {}) {
  return (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const parts: string[] = [`[${ts}]`, `[${level.toUpperCase()}]`, `[gpt]`];
    if (context.workerId !== undefined) parts.push(`[w:${context.workerId}]`);
    if (context.email) parts.push(`[${context.email}]`);
    if (context.step) parts.push(`[${context.step}]`);
    if (context.cli) parts.push(`[${context.cli}]`);

    parts.push(message);
    if (data) {
      parts.push(JSON.stringify(data));
    }
    const line = parts.join(" ");
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };
}
