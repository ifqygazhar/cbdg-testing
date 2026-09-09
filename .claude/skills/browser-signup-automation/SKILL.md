---
name: browser-signup-automation
description: Build or debug a Puppeteer signup/onboarding automation over @ifqy/google-oauth (Bun workspace). Use when adding a new target platform, when a run hangs or "bengong" on a page, or when a selector, OAuth click, or extracted value stops working. Enforces probe-before-guess so debugging costs one browser run instead of many exploratory ones.
---

# Browser signup automation

Automations here fail in a narrow, repeating set of ways. Diagnose by **probing
the live page**, never by reading the flow code and guessing. One probe run
answers what ten rounds of selector edits cannot.

## The rule

**A hang has exactly one question: what is on the page right now, and what
happens when we touch it?** Answer that with a throwaway probe script before
changing any flow code.

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

Delete the probe when done. Never leave one in `src/`.

## Diagnosis order

1. **Is the element there?** Dump every button with its `aria-label`. If the
   label you expect is absent, the surface changed — read
   `references/traps.md` §"button that does not exist yet".
2. **Does clicking it do anything?** Attach `pageerror` and click. A handler
   that throws is invisible in the flow log and looks exactly like a hang.
3. **Did a request fail or content-negotiate wrong?** Log responses and
   `request().headers()`. See §"forced headers" — this one is ours, not theirs.
4. **Only then** change the flow.

## What to write

Layout that has held up: `cli.ts` (flags → env), `config.ts` (env → typed
config), `loaders.ts` (seed files), `store.ts` (jsonl state + result writers),
`queue.ts` (skip logic, worker pool, spacing), `runner.ts` (one account: launch
→ flow → close), `flow/{selectors,steps,engine}.ts`.

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
- `references/probes.md` — copy-paste probe recipes (network trace, click
  trace, bundle spelunking, header inspection).
- `references/pacing.md` — making a run fast without making it robotic.
