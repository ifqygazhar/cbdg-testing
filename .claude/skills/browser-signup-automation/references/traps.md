# Failure catalogue

Every entry here cost a debugging session. Symptom first, because that is what
you have when you arrive.

---

## Forced headers break the site's own API

**Symptom.** The page renders. A button is visible and enabled. Clicking it
throws `TypeError: Cannot read properties of undefined (reading 'nodes')` (or
similar) from inside the site's bundle, and nothing happens.

**Cause.** `page.setExtraHTTPHeaders` applies to **every** request, not just
navigations. Pinning a browser-navigation `Accept: text/html,…` there makes the
app's own `fetch` send it too. Ory Kratos content-negotiates on `Accept`: with
`text/html` it answers `GET /self-service/login/browser` with a 303 to its HTML
login page instead of the flow JSON. The SPA stored that HTML string as its
`flow` object, so `flow.ui.nodes` exploded on click. The button stayed enabled
because a non-empty string is truthy.

**Fix.** Only set headers that are genuinely constant per browser
(`Accept-Language`, `DNT`). Chrome already sends a correct `Accept` per request
type.

**How to confirm in one run.** Log `r.request().headers()["accept"]` for
responses whose URL contains the auth path, and compare against
`application/json, text/plain, */*` (axios) or `*/*` (fetch).

---

## The button that does not exist yet

**Symptom.** Flow waits for a selector that "is obviously on the page" and
times out. A screenshot shows the page looking right.

**Cause.** The control lives behind another control. Crusoe's post-signup page
is a dashboard whose only relevant button is `Get API Key`; the `Create` button
and the name field only mount inside the flyout that button opens.

**Fix.** Wait for the *opener*, click it, then wait for the inner control. Keep
both in the selector file. Accept either surface when a platform may land on an
old and a new page.

**Tell.** Dump `aria-label` for every button. If the expected label is missing
but a plausible opener is present, this is it.

---

## Element exists but the scan says no

**Symptom.** `page.$(sel)` finds it, but an in-page `evaluate` scan returns
null, sub-millisecond, and the flow takes a fallback branch.

**Cause.** The frame navigated mid-scan. A destroyed execution context rejects
instantly, and a `catch (…) { return null }` makes that identical to "absent".

**Fix.** Retry once on a transient error (`execution context was destroyed`,
`target closed`, `detached frame`) before believing the negative. Log it.

---

## The fallback that leaves the page

**Symptom.** First scan misses; the automation then navigates somewhere else
and never recovers.

**Cause.** A generic "click login / sign in / get started" fallback. On a
landing page that already has the provider button, the only match was
`Already have an account? Login`, which navigated away and crashed the SPA.

**Fix.** If the page text already advertises the thing you want, wait for it.
Keep the fallback for pages that genuinely hide auth behind a route, and bound
how long it is suppressed.

---

## Regex declared outside, used inside

**Symptom.** A detector never fires. No error anywhere.

**Cause.** `page.evaluate(() => MY_RE.test(...))` — `MY_RE` is a Node binding
and does not exist in the browser. It throws `ReferenceError`, and the usual
`.catch(() => false)` turns every check into "no".

**Fix.** Pass `re.source` in as an argument and rebuild it inside the page.
Same for every constant.

---

## Key charset too narrow

**Symptom.** A one-time secret is displayed, the run reports it did not appear,
and the value is lost for good.

**Cause.** Validator was `^[A-Za-z0-9_-]{20,}$`. Real key:
`ZFvmGVC-QSO1vn7Ge23xYQ_2a_10_djXjYH64Ba97Ra/fHKiBA.h.8jg.0zKwMk9iEEYAuY5OKh0tvxXkm`
— it carries `/` and `.`. The first sample happened to have neither.

**Fix.** Treat the element that is *by construction* the value as authoritative:
accept it when it is long and whitespace-free, warn if the pattern disagrees,
and never throw the value away. Dump the page HTML on extraction failure so a
lost secret is still recoverable by hand.

---

## SPA error boundary

**Symptom.** "Unexpected Application Error!" replaces the whole UI.

**Cause.** A race in the target's own bundle, often after we navigated
somewhere unexpected.

**Fix.** Detect the error text and re-open the intended URL (not just reload —
the crash may have left a different route), bounded to a few attempts. Detect
via body text with the pattern passed into the page.

---

## Popup stolen by a sibling worker

**Symptom.** With parallel workers, one account's OAuth window ends up driven
by another account's flow.

**Fix.** Filter `targetcreated` to your own browser context and ignore the
page that opened it.

---

## Waiting for a network that never goes idle

**Symptom.** A fixed ~30 s pause per account before anything happens.

**Cause.** `waitForNetworkIdle({ timeout: 30_000 })` on a page with telemetry
or long-poll. It burns the full timeout and then proceeds anyway.

**Fix.** Race it against "the element I need is visible". See
`pacing.md`.
