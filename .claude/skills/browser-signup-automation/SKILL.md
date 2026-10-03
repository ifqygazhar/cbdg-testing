---
name: browser-signup-automation
description: Build or debug a browser signup/onboarding automation using either Bun (Puppeteer/Chromium) or Python (Camoufox/Firefox anti-Turnstile engine). Use when adding a new target platform, when Cloudflare Turnstile blocks login, when a run hangs or "bengong" on a page, or when a selector, OAuth click, or extracted value stops working. Enforces probe-before-guess so debugging costs one browser run instead of many exploratory ones.
---

# Browser signup automation

Automations here fail in a narrow, repeating set of ways. Diagnose by **probing
the live page**, never by reading the flow code and guessing. One probe run
answers what ten rounds of selector edits cannot.

## Dual-Engine Architecture

This repository supports two execution engines selectable per-run via CLI (`--engine bun|python`) or environment (`BROWSER_ENGINE=python|bun`):

1. **Bun Engine (`@ifqy/google-oauth` + Puppeteer / Chromium)**
   - Native TypeScript codebase under Bun workspaces (`apps/*`).
   - Best for fast, standard flows where Cloudflare Turnstile is absent or solvable via standard stealth flags.
   - Run via: `bun run <app> --engine bun` (or default `bun run <app>`).

2. **Python Engine (`packages/camoufox_core` + Camoufox / Firefox / Playwright)**
   - C++ patched Firefox build with genuine hardware spoofing (Canvas, WebGL, Audio, Fonts, GeoIP).
   - **Crucial for Cloudflare Turnstile & Clerk SSO challenges:** In our live tests, Camoufox completely bypasses Turnstile challenges silently where Chromium triggers "Security check: Complete this verification" and errors with "troubleshoot".
   - Run via: `bun run <app> --engine python` (delegates automatically), or `bun run <app>:python`, or `/home/azhar/.venvs/camoufox/bin/python apps/<app>/camoufox_runner.py`.

## The rule

**A hang has exactly one question: what is on the page right now, and what
happens when we touch it?** Answer that with a throwaway probe script before
changing any flow code.

### 1. Bun / Puppeteer Probe
```bash
# probe lives beside the app so the workspace import resolves
cat > apps/<app>/src/__probe.ts <<'TS'
import { launchGoogleOAuthBrowser, findGoogleTrigger, dom } from "@ifqy/google-oauth";
const handle = await launchGoogleOAuthBrowser({ headless: true, opts: { headless: true } });
const page = handle.page;
page.on("pageerror", (e) => console.log("pageerror:", String((e as Error).stack ?? e).slice(0, 400)));
page.on("response", (r) => { if (r.status() >= 400) console.log(r.status(), r.url().slice(0, 120)); });
try {
  await page.goto("<URL>", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  console.log(await page.evaluate(() =>
    Array.from(document.querySelectorAll("button,a,[role=button]")).map((el) => ({
      tag: el.tagName, label: el.getAttribute("aria-label"),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
    }))));
} finally { await handle.close().catch(() => {}); }
TS
bun run apps/<app>/src/__probe.ts; rm apps/<app>/src/__probe.ts
```

### 2. Camoufox / Python Probe (Use when testing Turnstile / Bot Protections)
```bash
cat > apps/<app>/__probe_camoufox.py <<'PY'
import asyncio
from camoufox.async_api import AsyncCamoufox

async def main():
    async with AsyncCamoufox(headless=True) as browser:
        page = await browser.new_page()
        page.on("pageerror", lambda e: print("pageerror:", str(e)[:300]))
        await page.goto("<URL>", wait_until="domcontentloaded")
        await asyncio.sleep(4)
        print("URL:", page.url)
        print("Title:", await page.title())
        buttons = await page.query_selector_all("button,a,[role=button]")
        for b in buttons:
            txt = (await b.text_content() or "").strip().replace("\n", " ")[:40]
            aria = await b.get_attribute("aria-label")
            testid = await b.get_attribute("data-testid")
            print(f"tag={b} aria={aria} testid={testid} text={txt}")
asyncio.run(main())
PY
/home/azhar/.venvs/camoufox/bin/python apps/<app>/__probe_camoufox.py; rm apps/<app>/__probe_camoufox.py
```

Delete the probe when done. Never commit temporary probes.

## Diagnosis order

1. **Is the element there?** Dump every button with its `aria-label`. If the
   label you expect is absent, the surface changed — read
   `references/traps.md` §"button that does not exist yet".
2. **Does clicking it trigger Cloudflare Turnstile or Security Check?** If
   Turnstile pops up and errors with "troubleshoot", switch to Camoufox (`--engine python`).
3. **Does clicking it do anything?** Attach `pageerror` and click. A handler
   that throws is invisible in the flow log and looks exactly like a hang.
4. **Did a request fail or content-negotiate wrong?** Log responses and
   `request().headers()`. See §"forced headers" — this one is ours, not theirs.
5. **Only then** change the flow.

## What to write

### Bun Apps
Layout: `cli.ts` (flags → env), `config.ts` (env → typed config), `loaders.ts` (seed files),
`store.ts` (jsonl state + result writers), `queue.ts` (skip logic, worker pool, spacing),
`runner.ts` (one account: launch → flow → close), `flow/{selectors,steps,engine}.ts`.

### Python Camoufox Runners
Layout: `apps/<app>/camoufox_runner.py` backed by `packages/camoufox_core`:
- `packages/camoufox_core/browser.py`: `launch_camoufox` with proxy & geoip.
- `packages/camoufox_core/google_oauth.py`: `perform_google_oauth` for Playwright.
- `packages/camoufox_core/loaders.py`: account & proxy parsers.
- `packages/camoufox_core/store.py`: jsonl state tracking & result writing.

Non-negotiables, each learned from a real failure:

- **One account, one browser launch, always closed** in `finally`.
- **Selectors in one file**, keyed off `aria-label` or stable `data-*`. CSS
  classes here are hashed (`css-c4xhxe`) and change per build.
- **Every step is resumable.** Write state before and after, and let a re-run
  detect an already-completed account rather than redoing it.
- **Never discard a value the site shows once.** Widen the validator instead,
  and dump the page on failure. See `references/traps.md` §"key charset".
- **Regression-test selectors against saved HTML** with `HTMLRewriter`, so a
  layout change fails a test instead of a run.

## Reference

- `references/traps.md` — the failure catalogue: symptom → cause → fix. Read
  this first when something hangs.
- `references/camoufox.md` — Camoufox architecture, anti-Turnstile bypass guide, and Playwright patterns.
- `references/tempmail.md` — TempMail-Pro integration, polling, email activation, and link extraction.
- `references/probes.md` — copy-paste probe recipes (network trace, click
  trace, bundle spelunking, header inspection).
- `references/pacing.md` — making a run fast without making it robotic.
