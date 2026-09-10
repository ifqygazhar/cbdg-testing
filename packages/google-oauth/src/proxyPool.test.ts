// ── One account, one proxy address ─────────────────────────────────
import { describe, it, expect } from "bun:test";
import { assignUniqueProxies } from "./proxyPool.js";

type Acc = { email: string };
type Prx = { server: string };

const accounts = (...emails: string[]): Acc[] => emails.map((email) => ({ email }));
const proxies = (...servers: string[]): Prx[] => servers.map((server) => ({ server }));
const run = (a: Acc[], p: Prx[], previous: Array<[string, string]> = [], reuse = false) =>
  assignUniqueProxies<Acc, Prx>({
    accounts: a,
    proxies: p,
    idOf: (x) => x.email,
    keyOf: (x) => x.server,
    previous: new Map(previous),
    reuse,
  });

describe("assignUniqueProxies", () => {
  it("gives every account its own address", () => {
    const r = run(accounts("a", "b", "c"), proxies("p1", "p2", "p3"));
    expect(r.paired.map((x) => x.proxy?.server)).toEqual(["p1", "p2", "p3"]);
    expect(r.heldBack).toEqual([]);
    expect(r.remaining).toBe(0);
  });

  it("never hands a spent address to a new account", () => {
    // The bug this exists for: a second run restarts the round-robin cursor and
    // account "c" would get p1, the address account "a" already signed up from.
    const r = run(accounts("c", "d"), proxies("p1", "p2", "p3", "p4"), [
      ["a", "p1"],
      ["b", "p2"],
    ]);
    expect(r.paired.map((x) => x.proxy?.server)).toEqual(["p3", "p4"]);
  });

  it("an account keeps the address it already used", () => {
    const r = run(accounts("a", "b"), proxies("p1", "p2", "p3"), [["a", "p2"]]);
    expect(r.paired[0]).toEqual({ account: { email: "a" }, proxy: { server: "p2" } });
    // and that address is not handed to anyone else
    expect(r.paired[1].proxy?.server).toBe("p1");
  });

  it("an account whose address is gone gets a fresh one", () => {
    // proxy-check drops dead addresses, so a retry must not chase p9 forever.
    const r = run(accounts("a"), proxies("p1", "p2"), [["a", "p9"]]);
    expect(r.paired[0].proxy?.server).toBe("p1");
  });

  it("undoes a shared address left by an older run", () => {
    // Real data looked like this: a restarting round-robin had given the same
    // address to many accounts. Keeping "what you already used" would have
    // preserved every one of those duplicates.
    const r = run(accounts("a", "b", "c"), proxies("p1", "p2", "p3", "p4"), [
      ["a", "p1"],
      ["b", "p1"],
      ["c", "p1"],
    ]);
    const got = r.paired.map((x) => x.proxy?.server);
    expect(got[0]).toBe("p1"); // the first owner keeps it
    expect(new Set(got).size).toBe(3); // and nobody doubles up
    expect(got).toEqual(["p1", "p2", "p3"]);
  });

  it("holds accounts back instead of doubling up", () => {
    const r = run(accounts("a", "b", "c"), proxies("p1", "p2"));
    expect(r.paired.map((x) => x.proxy?.server)).toEqual(["p1", "p2"]);
    expect(r.heldBack.map((x) => x.email)).toEqual(["c"]);
  });

  it("reuse turns the hold-back into round-robin", () => {
    const r = run(accounts("a", "b", "c", "d"), proxies("p1", "p2"), [], true);
    expect(r.paired.map((x) => x.proxy?.server)).toEqual(["p1", "p2", "p1", "p2"]);
    expect(r.heldBack).toEqual([]);
  });

  it("the same address twice is still one address", () => {
    // Harvesting from several webshare accounts yields overlapping ranges, so
    // the pool really does contain one host:port under two credentials.
    const r = run(accounts("a", "b"), proxies("p1", "p1", "p2"));
    expect(r.distinct).toBe(2);
    expect(r.paired.map((x) => x.proxy?.server)).toEqual(["p1", "p2"]);
  });

  it("no proxies at all means everyone runs direct, nobody is held back", () => {
    const r = run(accounts("a", "b"), []);
    expect(r.paired.map((x) => x.proxy)).toEqual([null, null]);
    expect(r.heldBack).toEqual([]);
  });

  it("reports what is left for the next batch", () => {
    const r = run(accounts("a"), proxies("p1", "p2", "p3"), [["x", "p1"]]);
    expect(r.paired[0].proxy?.server).toBe("p2");
    expect(r.remaining).toBe(1);
  });

  it("is stable: the same inputs pair the same way twice", () => {
    const args: [Acc[], Prx[], Array<[string, string]>] = [
      accounts("a", "b"),
      proxies("p1", "p2", "p3"),
      [["z", "p1"]],
    ];
    expect(run(...args).paired).toEqual(run(...args).paired);
  });
});
