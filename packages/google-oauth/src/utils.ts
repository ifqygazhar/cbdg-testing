// ── Shared utilities (Bun-compatible) ─────────────────────────────
// Ported from cline-regist/cline/utils.js

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function humanPause(min = 300, max = 800): Promise<void> {
  return sleep(randomInt(min, max));
}

export function humanTypeDelay(): number {
  return randomInt(30, 90);
}

export function sanitizeFileName(value: string): string {
  return String(value).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
}

export function oneLine(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}