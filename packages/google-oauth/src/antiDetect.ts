// ── Anti-detect: human simulation + viewport jitter ────────────────
// Ported from cline-regist/cline/anti-detect.js.
// Stealth browser fingerprinting is handled by puppeteer-extra-plugin-stealth;
// this file only adds human-like micro-movements.

import type { Page } from "puppeteer-core";
import { sleep, randomInt } from "./utils.js";
import { resolvePace, type Pace, type PaceName } from "./pace.js";

export async function simulateHumanBehavior(
  page: Page,
  pace?: PaceName | Pace,
): Promise<void> {
  const p = resolvePace(pace);
  if (p.mouseMoves <= 0) return;
  try {
    const moves = randomInt(1, p.mouseMoves);
    for (let i = 0; i < moves; i++) {
      const x = randomInt(100, 1000);
      const y = randomInt(100, 600);
      await page.mouse.move(x, y, { steps: randomInt(3, 8) });
      await sleep(randomInt(Math.round(p.pauseMin / 4), Math.round(p.pauseMax / 4)));
    }
    await sleep(randomInt(p.pauseMin, p.pauseMax));
  } catch {
    /* non-fatal */
  }
}

async function wheel(page: Page, deltaY: number): Promise<void> {
  try {
    await (page.mouse.wheel as (o: { deltaY: number }) => Promise<void>)({ deltaY });
  } catch {
    try {
      await (page.mouse.wheel as unknown as (dx: number, dy: number) => Promise<void>)(0, deltaY);
    } catch {
      /* ignore */
    }
  }
}

export async function simulateHumanScroll(page: Page): Promise<void> {
  try {
    const scrollAmount = randomInt(100, 400);
    const direction = Math.random() > 0.5 ? 1 : -1;
    await wheel(page, scrollAmount * direction);
    await sleep(randomInt(300, 800));
    await wheel(page, -scrollAmount * direction * 0.5);
    await sleep(randomInt(200, 500));
  } catch {
    /* ignore */
  }
}

export function getRandomViewport(): { width: number; height: number } {
  const baseWidth = 1280;
  const baseHeight = 800;
  const jitter = 50;
  return {
    width: baseWidth + randomInt(-jitter, jitter),
    height: baseHeight + randomInt(-jitter, jitter),
  };
}