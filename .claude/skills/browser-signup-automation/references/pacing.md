# Fast without being robotic

Two very different things make a run slow:

1. **Deliberate pauses** that make behaviour look human. Worth keeping.
2. **Blind waiting** for something that already happened. Pure waste.

Only cut the second. `@ifqy/google-oauth` ships three profiles (`fast`,
`human`, `careful`) via `pace`; `fast` keeps randomised typing (18-55 ms per
character), mouse moves and 120-380 ms pauses, and only tightens the waiting.

## The pattern that pays

Replace a blind wait with a race against actual readiness:

```ts
await Promise.race([
  page.waitForNetworkIdle({ idleTime: pace.settleIdleMs, timeout: pace.settleTimeoutMs }).catch(() => {}),
  waitForAnySelector(page, READY_SELECTORS, pace.settleTimeoutMs).then(() => undefined),
]);
```

Both branches share the timeout, so the race always ends. On an OAuth page the
network never falls idle, so the old call spent its entire 30 s budget; the
selector branch resolves in tens of milliseconds.

## Rules of thumb

- Never type with `delay: 0`. Instant input across a whole form is a classic
  bot tell, and it costs almost nothing to keep it human.
- Poll intervals belong in the profile, not scattered as `sleep(1000)`.
- A per-action pause is cheap; a per-page blind wait is not. Audit the blind
  waits first.
- **Pace is not risk control.** Spacing between accounts is what a risk engine
  measures. Keep the inter-account delay even on the fast profile, and keep one
  fresh browser (and ideally one proxy) per account.
- Measure before claiming a speedup: log a timestamp at each flow step and read
  the gaps. The 30 s wait was found that way, not by inspection.
