// ── One account, one proxy address ─────────────────────────────────
// Round-robin over the pool gives each account a different proxy inside a single
// run, but the cursor restarts on the next run — so the second batch hands
// account #1's address to a different account. Pairing has to be decided from
// what previous runs recorded, not from a position in a list.

export interface AssignOptions<A, P> {
  accounts: A[];
  proxies: P[];
  /** stable identity of an account (its email) */
  idOf: (account: A) => string;
  /** stable identity of a proxy (its server URL) */
  keyOf: (proxy: P) => string;
  /** what earlier runs already spent: account id → proxy key */
  previous: Map<string, string>;
  /** let one address serve several accounts instead of holding accounts back */
  reuse?: boolean;
}

export interface Assignment<A, P> {
  paired: Array<{ account: A; proxy: P | null }>;
  /** accounts with no unused address left; not processed unless `reuse` */
  heldBack: A[];
  /** addresses still untouched after this pass */
  remaining: number;
  /** distinct addresses in the pool, after collapsing duplicate host:port */
  distinct: number;
}

/**
 * Pair each account with an address no other account has used.
 *
 * An account that already has one keeps it: the site has seen that account from
 * that address, and a retry from somewhere else is a worse signal than a repeat.
 * If its old address is gone from the pool (a dead proxy filtered out by
 * proxy-check) it gets a fresh one instead.
 *
 * With no addresses left, accounts are held back rather than doubled up —
 * silently sharing an address is exactly what the caller asked to avoid. Pass
 * `reuse` to fall back to round-robin.
 */
export function assignUniqueProxies<A, P>(opts: AssignOptions<A, P>): Assignment<A, P> {
  const { accounts, proxies, idOf, keyOf, previous, reuse = false } = opts;

  if (proxies.length === 0) {
    return {
      paired: accounts.map((account) => ({ account, proxy: null })),
      heldBack: [],
      remaining: 0,
      distinct: 0,
    };
  }

  // The pool can hold the same address more than once: harvesting from several
  // accounts yields overlapping ranges, and the same host:port with different
  // credentials is still one address. Collapse them, or "one account per
  // address" quietly hands the same address to two accounts.
  const byKey = new Map<string, P>();
  for (const p of proxies) {
    if (!byKey.has(keyOf(p))) byKey.set(keyOf(p), p);
  }
  const unique = [...byKey.values()];

  // Who owns each address historically. Earlier runs could hand the same
  // address to several accounts (a round-robin cursor that restarts does
  // exactly that), so an address has one owner and the rest are treated as
  // never having had one. Without this, "keep what you used" would faithfully
  // preserve the duplicates it is meant to undo.
  const owner = new Map<string, string>();
  for (const [id, key] of previous) {
    if (!owner.has(key)) owner.set(key, id);
  }
  const spent = new Set(owner.keys());
  const free = unique.filter((p) => !spent.has(keyOf(p)));
  let cursor = 0;
  let rr = 0;

  const paired: Array<{ account: A; proxy: P | null }> = [];
  const heldBack: A[] = [];

  for (const account of accounts) {
    const id = idOf(account);
    const previousKey = previous.get(id);
    // Only the owner keeps it; a co-tenant from an older run is moved off.
    const kept = previousKey && owner.get(previousKey) === id ? byKey.get(previousKey) : undefined;
    if (kept) {
      paired.push({ account, proxy: kept });
      continue;
    }
    if (cursor < free.length) {
      const proxy = free[cursor++];
      spent.add(keyOf(proxy));
      paired.push({ account, proxy });
      continue;
    }
    if (reuse) {
      paired.push({ account, proxy: unique[rr++ % unique.length] });
      continue;
    }
    heldBack.push(account);
  }

  return { paired, heldBack, remaining: Math.max(0, free.length - cursor), distinct: unique.length };
}
