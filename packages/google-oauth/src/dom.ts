// ── DOM helpers (Puppeteer) ─────────────────────────────────────────
// Ported from cline-regist/cline/dom-helpers.js — text-based clicking,
// input filling, frame-aware search, shadow DOM piercing.

import type { Page, ElementHandle, Frame } from "puppeteer-core";
import { sleep, randomInt, humanPause, normalizeText } from "./utils.js";
import { resolvePace } from "./pace.js";
import type { GoogleOAuthOptions } from "./config.js";

type Options = GoogleOAuthOptions;

// ── Resilient evaluation ────────────────────────────────────────────

/** Errors that mean "the page moved under us", not "the code is wrong". */
const TRANSIENT_EVAL_RE =
  /execution context was destroyed|cannot find context|target closed|session closed|detached frame|frame got detached|no frame for given id/i;

export function isTransientEvalError(e: unknown): boolean {
  return TRANSIENT_EVAL_RE.test(String((e as Error)?.message ?? e));
}

/**
 * Evaluate with one retry when the page navigates mid-call. Without this a
 * single re-render makes an element look absent, and callers take a wrong
 * branch (clicking something else, or failing an account outright).
 */
export async function safeEvaluate<T>(
  target: { evaluate: (fn: never, ...args: never[]) => Promise<T> },
  fn: unknown,
  ...args: unknown[]
): Promise<{ ok: true; value: T } | { ok: false; transient: boolean; error: Error }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await target.evaluate(fn as never, ...(args as never[]));
      return { ok: true, value };
    } catch (e) {
      const error = e as Error;
      const transient = isTransientEvalError(error);
      if (!transient || attempt === 1) return { ok: false, transient, error };
      await sleep(250);
    }
  }
  /* unreachable */
  return { ok: false, transient: false, error: new Error("safeEvaluate: exhausted") };
}

// ── Text-based click ────────────────────────────────────────────────

export async function clickByText(
  page: Page,
  texts: string | readonly string[],
  opts: Options = {},
  { optional = false } = {},
): Promise<boolean> {
  const needles = Array.isArray(texts) ? [...texts] : [texts];

  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle(
        (m: { needles: string[] }) => {
          const needles = m.needles as string[];
          const norm = (v: unknown) =>
            String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
          const visible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              el.getAttribute("aria-disabled") !== "true" &&
              !el.hasAttribute("disabled")
            );
          };
          function deepCollect(selector: string): Element[] {
            const out: Element[] = [];
            const seen = new Set<Element>();
            const walk = (root: Document | ShadowRoot) => {
              let matches: Element[] = [];
              try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
              for (const el of matches) if (!seen.has(el)) { seen.add(el); out.push(el); }
              const all: Element[] = Array.from((root as Document).querySelectorAll("*") ?? root.querySelectorAll("*"));
              for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
            };
            walk(document);
            return out;
          }
          const selector = [
            "button", "a", '[role="button"]',
            "input[type=button]", "input[type=submit]", "[jsname]",
          ].join(",");
          const els = deepCollect(selector);
          let best: Element | null = null;
          let bestScore = -1;
          for (const el of els) {
            if (!visible(el)) continue;
            const img = el.querySelector("img");
            const text = norm(
              [
                el.textContent,
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("value"),
                img && img.getAttribute("alt"),
              ].filter(Boolean).join(" "),
            );
            if (!text || text.length > 120) continue;
            const idx = needles.findIndex((n) => text.includes(n));
            if (idx === -1) continue;
            const tag = el.tagName.toLowerCase();
            const isRealButton =
              tag === "button" || tag === "a" || tag === "input" ||
              el.getAttribute("role") === "button";
            let score = 0;
            if (isRealButton) score += 100;
            score += needles.length - idx;
            score += Math.max(0, 40 - text.length);
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best as unknown as Element | null;
        },
        { needles },
      );

      const element = handle.asElement() as ElementHandle<Element> | null;
      if (element) {
        const pace = resolvePace(opts.pace);
        await humanPause(pace.pauseMin, pace.pauseMax);
        // safeClick scrolls into view and falls back to a DOM click; a bare
        // element.click() fails on anything below the fold or covered by a
        // sticky header, which is common outside the pages we tested on.
        const clicked = await safeClick(page, element);
        await handle.dispose().catch(() => {});
        if (clicked) return true;
        continue;
      }
      await handle.dispose().catch(() => {});
    } catch {
      continue;
    }
  }

  if (!optional) {
    console.warn(`clickByText: no element found for [${needles.join(", ")}]`);
  }
  return false;
}

// ── Safe click with scroll into view ───────────────────────────────

export async function safeClick(
  page: Page,
  element: ElementHandle<Element>,
): Promise<boolean> {
  try {
    await element.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await sleep(randomInt(100, 300));
    await element.click();
    return true;
  } catch {
    try {
      await element.evaluate((el) => (el as HTMLElement).click());
      return true;
    } catch {
      return false;
    }
  }
}

// ── Wait for any selector ───────────────────────────────────────────

export async function waitForAnySelector(
  page: Page,
  selectors: string[],
  timeoutMs = 15000,
): Promise<ElementHandle<Element> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el
            .evaluate((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 &&
                style.display !== "none" && style.visibility !== "hidden";
            })
            .catch(() => false);
          if (visible) return el;
        }
      } catch {
        /* continue */
      }
    }
    await sleep(300);
  }
  return null;
}

// ── Wait for visible input (frame-aware) ───────────────────────────

export interface VisibleInput {
  element: ElementHandle<Element>;
  frame: Frame;
}

export async function waitForVisibleInput(
  page: Page,
  selectors: string[],
  timeoutMs = 15000,
): Promise<VisibleInput | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      for (const frame of page.frames()) {
        try {
          const el = await frame.$(sel);
          if (!el) continue;
          const visible = await el
            .evaluate((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 &&
                style.display !== "none" && style.visibility !== "hidden";
            })
            .catch(() => false);
          if (visible) return { element: el, frame };
        } catch {
          continue;
        }
      }
    }
    await sleep(300);
  }
  return null;
}

// ── Focus input ─────────────────────────────────────────────────────

export async function focusInput(
  page: Page,
  element: ElementHandle<Element>,
): Promise<boolean> {
  try {
    await element.evaluate((node) => {
      (node as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
      (node as HTMLInputElement).focus();
      if (typeof (node as HTMLInputElement).select === "function") (node as HTMLInputElement).select();
    });
    return true;
  } catch {
    try {
      await element.click({ clickCount: 3 });
      return true;
    } catch {
      await page.keyboard.press("Tab");
      return false;
    }
  }
}

// ── Fill input with native setter (most reliable) ───────────────────

export async function fillInput(
  page: Page,
  element: ElementHandle<Element>,
  value: string,
): Promise<boolean> {
  await focusInput(page, element);

  // Strategy 1: native setter + dispatchEvent (bypasses React/Vue/Angular)
  const domFilled = await element
    .evaluate((node, nextValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(node, nextValue);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      (node as HTMLInputElement).focus();
      return (node as HTMLInputElement).value === nextValue;
    }, value)
    .catch(() => false);

  if (domFilled) return true;

  // Strategy 2: keyboard fallback
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.type(value, { delay: 0 });
  return true;
}

// ── Type text with human-like delays ────────────────────────────────

export async function humanType(
  element: ElementHandle<Element>,
  text: string,
  opts: Options = {},
): Promise<void> {
  const min = opts.typeDelayMin ?? 30;
  const max = opts.typeDelayMax ?? 90;
  for (const char of text) {
    await element.type(char, { delay: randomInt(min, max) });
  }
}

// ── Wait for page to settle ─────────────────────────────────────────

export async function waitForSettledPage(page: Page): Promise<void> {
  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 });
  } catch {
    await sleep(1500);
  }
}

// ── Popup handler ───────────────────────────────────────────────────

export async function withPopup(
  page: Page,
  action: () => Promise<unknown>,
  { sameTabDone } = {} as { sameTabDone?: (p: Page) => boolean | Promise<boolean> },
): Promise<Page | null> {
  const browser = page.browser();
  const ownContext = page.browserContext();
  const holder: { popup: Page | null } = { popup: null };
  const onTarget = async (target: {
    type: () => string;
    page: () => Promise<Page>;
    browserContext?: () => unknown;
  }) => {
    if (target.type() !== "page") return;
    // Only accept popups from OUR context. With several accounts running in
    // parallel contexts, a sibling's popup would otherwise be hijacked here.
    if (typeof target.browserContext === "function" && target.browserContext() !== ownContext) {
      return;
    }
    const popup = await target.page().catch(() => null);
    if (popup && popup !== page) holder.popup = popup;
  };
  browser.on("targetcreated" as never, onTarget as never);

  try {
    await action();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !holder.popup) {
      if (sameTabDone) {
        const done = await Promise.resolve(sameTabDone(page)).catch(() => false);
        if (done) return null;
      }
      await sleep(250);
    }
  } finally {
    browser.off("targetcreated" as never, onTarget as never);
  }

  const popup = holder.popup;
  if (popup) {
    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    return popup;
  }
  return null;
}

// ── Find clickable by text (returns element, not bool) ─────────────

export async function findClickableByText(
  page: Page,
  texts: string | readonly string[],
): Promise<ElementHandle<Element> | null> {
  const needles = Array.isArray(texts) ? [...texts] : [texts];

  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle(
        (m: { needles: string[] }) => {
          const needles = m.needles as string[];
          const norm = (v: unknown) =>
            String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
          const visible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              !el.hasAttribute("disabled") &&
              el.getAttribute("aria-disabled") !== "true"
            );
          };
          function deepCollect(selector: string): Element[] {
            const out: Element[] = [];
            const seen = new Set<Element>();
            const walk = (root: Document | ShadowRoot) => {
              let matches: Element[] = [];
              try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
              for (const el of matches) if (!seen.has(el)) { seen.add(el); out.push(el); }
              const all = matches.length ? [] : [];
              void all;
              let q = [] as Element[];
              try { q = Array.from(root.querySelectorAll("*")); } catch { q = []; }
              for (const el of q) if (el.shadowRoot) walk(el.shadowRoot);
            };
            walk(document);
            return out;
          }
          const selector = [
            "button", "a", '[role="button"]',
            "input[type=button]", "input[type=submit]", "[jsname]",
          ].join(",");
          const els = deepCollect(selector);
          let best: Element | null = null;
          let bestScore = -1;
          for (const el of els) {
            if (!visible(el)) continue;
            const text = norm(
              [
                el.textContent,
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("value"),
              ].filter(Boolean).join(" "),
            );
            if (!text || text.length > 120) continue;
            const idx = needles.findIndex((n) => text.includes(n));
            if (idx === -1) continue;
            const tag = el.tagName.toLowerCase();
            const isRealButton =
              tag === "button" || tag === "a" || tag === "input" ||
              el.getAttribute("role") === "button";
            let score = 0;
            if (isRealButton) score += 100;
            score += needles.length - idx;
            score += Math.max(0, 40 - text.length);
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best as unknown as Element | null;
        },
        { needles },
      );

      const element = handle.asElement() as ElementHandle<Element> | null;
      if (element) return element;
      await handle.dispose().catch(() => {});
    } catch {
      continue;
    }
  }

  return null;
}

// ── duplicate normalizer re-export for convenience ─────────────────
export { normalizeText };