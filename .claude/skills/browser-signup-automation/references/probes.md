# Probe recipes

Put a probe at `apps/<app>/src/__probe.ts` so workspace imports resolve, run it
with `bun run`, then delete it. Headless is fine for diagnosis and much faster.

`page.browser()` events and `page.on(...)` listeners cost nothing and answer
most questions on the first run — attach them all.

## 1. What is clickable

```ts
console.log(await page.evaluate(() =>
  Array.from(document.querySelectorAll("button,a,[role=button],input[type=submit]")).map((el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return {
      tag: el.tagName,
      label: el.getAttribute("aria-label"),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height),
      display: s.display, visibility: s.visibility, opacity: s.opacity,
      ariaDisabled: el.getAttribute("aria-disabled"), disabled: el.hasAttribute("disabled"),
    };
  })));
```

Answers "is it there", "is it visible", "is it disabled" in one shot. A control
whose `aria-disabled` is `"true"` is skipped by the library's own scanner.

## 2. What happens when we click

```ts
page.on("pageerror", (e) => console.log("pageerror:", String((e as Error).stack ?? e).slice(0, 400)));
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("nav:", f.url().slice(0, 90)); });
page.browser().on("targetcreated", (t) => console.log("target:", t.type(), String(t.url()).slice(0, 90)));
await dom.safeClick(page, el);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  console.log(i, page.url().slice(0, 100), (await page.browser().pages()).length);
}
```

A handler that throws prints here and nowhere else. This is the single highest
value probe: it separates "we never clicked" from "we clicked and their code
broke".

## 3. Network and content negotiation

```ts
page.on("response", (r) => {
  const t = r.request().resourceType();
  if (t === "xhr" || t === "fetch" || t === "document") {
    console.log(r.status(), r.request().method(), r.url().slice(0, 110),
      "| accept:", r.request().headers()["accept"],
      "| type:", r.headers()["content-type"]);
  }
});
page.on("requestfailed", (r) => console.log("FAILED", r.url().slice(0, 110), r.failure()?.errorText));
```

Look for a 3xx where JSON was expected, and for an `accept` header you did not
choose. Compare with a manual probe from inside the page:

```ts
await page.evaluate(async () => {
  const r = await fetch("/auth/self-service/login/browser", { headers: { Accept: "application/json" } });
  return { status: r.status, type: r.headers.get("content-type"), url: r.url };
});
```

## 4. Read their bundle

When a click throws inside minified code, the stack gives `file:line:col`.

```bash
curl -sS -o /tmp/app.js "https://<host>/assets/index-<hash>.js"
awk 'NR==<line>' /tmp/app.js | cut -c<col-400>-<col+400>
grep -o -E '.{250}self-service/(login|registration)/browser.{150}' /tmp/app.js
```

Minified names are stable within a build. Find the throwing helper, then grep
for the component that calls it. This is how `os(flow)` was traced to
`flow.ui.nodes` and, from there, to the flow fetch.

## 5. Verify a fix without spending an account

Everything above is read-only up to the provider click. Clicking the OAuth
button and stopping at the account chooser enters no credentials and creates
nothing. Do that to prove the click works, then close the browser.

Confirm the real flow only on an account that is already burned, or with
`--retry-failed` on one that half-completed.
