// ── Screenshot helpers ─────────────────────────────────────────────
import path from "node:path";
import fs from "node:fs";
import type { Page } from "puppeteer-core";
import { sanitizeFileName } from "./utils.js";
import type { GoogleOAuthOptions } from "./config.js";

export function screenshotPath(dir: string, email: string, stage: string): string {
  return path.join(dir, `${sanitizeFileName(email)}_${stage}_${Date.now()}.png`);
}

export async function takeScreenshot(
  page: Page,
  filePath: string,
  opts: GoogleOAuthOptions,
): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: false });
    opts.log?.("info", `screenshot saved: ${filePath}`);
  } catch (e) {
    opts.log?.("warn", `screenshot failed: ${(e as Error).message}`);
  }
}