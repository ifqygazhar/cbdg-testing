// ── Launcher plan tests: the flags it composes must be the real flags ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextToken } from "./prompt.js";
import {
  APP_ENTRY,
  IS_TOOL,
  PROXY_CAPABLE,
  buildArgs,
  commandLine,
  getRemainingAccountsForApp,
  googleDirectEnabled,
  proxyReuseEnabled,
  readSeeds,
  warningsFor,
  type RunPlan,
  type SeedInfo,
} from "./plan.js";
import { parseArgs as parseCbdg, applyArgsToEnv as envCbdg } from "../apps/cbdg/src/cli.js";
import { parseArgs as parseCrusoe, applyArgsToEnv as envCrusoe } from "../apps/crusoe/src/cli.js";
import { parseArgs as parseFastrouter, applyArgsToEnv as envFastrouter } from "../apps/fastrouter/src/cli.js";
import { parseArgs as parseTokenharbor, applyArgsToEnv as envTokenharbor } from "../apps/tokenharbor/src/cli.js";
import { parseArgs as parseGroqcloud, applyArgsToEnv as envGroqcloud } from "../apps/groqcloud/src/cli.js";
import { parseArgs as parseWebshare, applyArgsToEnv as envWebshare } from "../apps/webshare/src/cli.js";

const base: RunPlan = {
  app: "cbdg",
  pace: "human",
  mode: "full",
  useProxy: true,
  googleDirect: true,
  headless: false,
  retryFailed: false,
  dryRun: false,
  delaySec: 60,
  workers: 1,
};

describe("buildArgs", () => {
  it("cbdg full run with proxy", () => {
    expect(buildArgs(base)).toEqual(["--headed", "--pace", "human", "--full", "--with-proxy", "--delay", "60"]);
  });
  it("cbdg signup-only without proxy", () => {
    expect(buildArgs({ ...base, mode: "signup", useProxy: false })).toContain("--signup-only");
    expect(buildArgs({ ...base, mode: "signup", useProxy: false })).toContain("--no-proxy");
  });
  it("crusoe gets the proxy switch, webshare does not", () => {
    const crusoe = buildArgs({ ...base, app: "crusoe", mode: undefined });
    expect(crusoe).toContain("--with-proxy");
    expect(crusoe).not.toContain("--full");
    const webshare = buildArgs({ ...base, app: "webshare", mode: undefined, useProxy: undefined });
    expect(webshare.some((a) => a.includes("proxy"))).toBe(false);
  });
  it("optional flags only appear when they change something", () => {
    const quiet = buildArgs({ ...base, delaySec: 0, workers: 1 });
    expect(quiet).not.toContain("--delay");
    expect(quiet).not.toContain("-w");
    const loud = buildArgs({ ...base, workers: 3, retryFailed: true, dryRun: true, headless: true, limit: 5 });
    expect(loud).toContain("--headless");
    expect(loud).toEqual(expect.arrayContaining(["-w", "3", "--retry-failed", "--dry-run", "--limit", "5"]));
  });
  it("fastrouter, crusoe, tokenharbor, groqcloud, llm7io, and webshare get the engine switch when python chosen", () => {
    const frPython = buildArgs({ ...base, app: "fastrouter", engine: "python" });
    expect(frPython).toEqual(expect.arrayContaining(["--engine", "python"]));
    const crusoePython = buildArgs({ ...base, app: "crusoe", engine: "python" });
    expect(crusoePython).toEqual(expect.arrayContaining(["--engine", "python"]));
    const thPython = buildArgs({ ...base, app: "tokenharbor", engine: "python" });
    expect(thPython).toEqual(expect.arrayContaining(["--engine", "python"]));
    const gqPython = buildArgs({ ...base, app: "groqcloud", engine: "python" });
    expect(gqPython).toEqual(expect.arrayContaining(["--engine", "python"]));
    const llm7Python = buildArgs({ ...base, app: "llm7io", engine: "python" });
    expect(llm7Python).toEqual(expect.arrayContaining(["--engine", "python"]));
    const wsPython = buildArgs({ ...base, app: "webshare", engine: "python" });
    expect(wsPython).toEqual(expect.arrayContaining(["--engine", "python"]));
    const ibPython = buildArgs({ ...base, app: "inferbase", engine: "python" });
    expect(ibPython).toEqual(expect.arrayContaining(["--engine", "python"]));
    // bun engine is default so no flag needed
    const frBun = buildArgs({ ...base, app: "fastrouter", engine: "bun" });
    expect(frBun).not.toContain("--engine");
    const thBun = buildArgs({ ...base, app: "tokenharbor", engine: "bun" });
    expect(thBun).not.toContain("--engine");
    const gqBun = buildArgs({ ...base, app: "groqcloud", engine: "bun" });
    expect(gqBun).not.toContain("--engine");
    const llm7Bun = buildArgs({ ...base, app: "llm7io", engine: "bun" });
    expect(llm7Bun).not.toContain("--engine");
    const wsBun = buildArgs({ ...base, app: "webshare", engine: "bun" });
    expect(wsBun).not.toContain("--engine");
    const ibBun = buildArgs({ ...base, app: "inferbase", engine: "bun" });
    expect(ibBun).not.toContain("--engine");
    // cbdg doesn't support camoufox engine
    const cbdg = buildArgs({ ...base, app: "cbdg", engine: "python" });
    expect(cbdg).not.toContain("--engine");
  });

  it("tokenharbor and groqcloud get domain flag when specified", () => {
    const th = buildArgs({ ...base, app: "tokenharbor", domain: "meongtopup.my.id" });
    expect(th).toContain("--domain");
    expect(th).toContain("meongtopup.my.id");
    const gq = buildArgs({ ...base, app: "groqcloud", domain: "meongtopup.my.id" });
    expect(gq).toContain("--domain");
    expect(gq).toContain("meongtopup.my.id");
  });

  it("tokenharbor gets gsuite-mode flag when specified", () => {
    const th1 = buildArgs({ ...base, app: "tokenharbor", authMethod: "google", gsuiteMode: "skip_existing" });
    expect(th1).toContain("--gsuite-mode");
    expect(th1).toContain("skip_existing");
    const th2 = buildArgs({ ...base, app: "tokenharbor", authMethod: "google", gsuiteMode: "create_new_key" });
    expect(th2).toContain("--gsuite-mode");
    expect(th2).toContain("create_new_key");
    const th3 = buildArgs({ ...base, app: "tokenharbor", authMethod: "google", gsuiteMode: "fetch_existing" });
    expect(th3).toContain("--gsuite-mode");
    expect(th3).toContain("fetch_existing");
  });

  it("fastrouter gets auth and domain flags when tempmail chosen", () => {
    const fr = buildArgs({
      ...base,
      app: "fastrouter",
      authMethod: "tempmail",
      domain: "ifqy.net",
      limit: 10,
    });
    expect(fr).toContain("--auth");
    expect(fr).toContain("tempmail");
    expect(fr).toContain("--domain");
    expect(fr).toContain("ifqy.net");
    expect(fr).toContain("--limit");
    expect(fr).toContain("10");
  });

  it("spells out google-direct only when it is turned off", () => {
    // The printed command has to reproduce the run. With GOOGLE_DIRECT=0 in
    // .env and no flag emitted, pasting it elsewhere would silently behave
    // differently.
    expect(buildArgs({ ...base, googleDirect: true })).not.toContain("--no-google-direct");
    expect(buildArgs({ ...base, googleDirect: false })).toContain("--no-google-direct");
    // nothing to bypass when the run is not proxied at all
    expect(buildArgs({ ...base, useProxy: false, googleDirect: false })).not.toContain("--no-google-direct");
    // and it is not a knob webshare has
    expect(buildArgs({ ...base, app: "webshare", mode: undefined, useProxy: undefined, googleDirect: false }))
      .not.toContain("--no-google-direct");
  });
  it("warns only when google is pushed through the proxy", () => {
    const seeds = { accounts: 5, proxies: 5, live: 5, liveAddresses: 5, cards: 2 };
    expect(warningsFor({ ...base, mode: "signup", googleDirect: false }, seeds).join(" ")).toContain("captcha");
    expect(warningsFor({ ...base, mode: "signup", googleDirect: true }, seeds)).toEqual([]);
  });
  it("spells out reuse-proxy when enabled and unique-proxy when overriding env", () => {
    expect(buildArgs({ ...base, reuseProxy: true })).toContain("--reuse-proxy");
    expect(buildArgs({ ...base, reuseProxy: false })).not.toContain("--reuse-proxy");
    // overrides PROXY_REUSE=1 in env with --unique-proxy
    const orig = process.env.PROXY_REUSE;
    try {
      process.env.PROXY_REUSE = "1";
      expect(buildArgs({ ...base, reuseProxy: false })).toContain("--unique-proxy");
    } finally {
      if (orig !== undefined) process.env.PROXY_REUSE = orig;
      else delete process.env.PROXY_REUSE;
    }
  });
  it("proxyReuseEnabled reads PROXY_REUSE knob correctly", () => {
    expect(proxyReuseEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(proxyReuseEnabled({ PROXY_REUSE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(proxyReuseEnabled({ PROXY_REUSE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(proxyReuseEnabled({ PROXY_REUSE: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("googleDirectEnabled reads the same knob the apps read", () => {
    expect(googleDirectEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(googleDirectEnabled({ GOOGLE_DIRECT: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(googleDirectEnabled({ GOOGLE_DIRECT: "yes" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("commandLine is copy-pasteable", () => {
    expect(commandLine(base)).toBe("bun run cbdg -- --headed --pace human --full --with-proxy --delay 60");
    expect(commandLine({ ...base, reuseProxy: true })).toBe(
      "bun run cbdg -- --headed --pace human --full --with-proxy --reuse-proxy --delay 60",
    );
  });
});

// The launcher is only useful if every flag it emits is one the app accepts.
describe("emitted flags are understood by the apps", () => {
  const cases: Array<[RunPlan, (a: string[]) => NodeJS.ProcessEnv]> = [
    [{ ...base }, (a) => envCbdg(parseCbdg(a, () => {}), {})],
    [{ ...base, reuseProxy: true }, (a) => envCbdg(parseCbdg(a, () => {}), {})],
    [{ ...base, mode: "signup", useProxy: false }, (a) => envCbdg(parseCbdg(a, () => {}), {})],
    [{ ...base, app: "crusoe", mode: undefined }, (a) => envCrusoe(parseCrusoe(a), {})],
    [{ ...base, app: "crusoe", mode: undefined, reuseProxy: true }, (a) => envCrusoe(parseCrusoe(a), {})],
    [{ ...base, app: "crusoe", mode: undefined, useProxy: false }, (a) => envCrusoe(parseCrusoe(a), {})],
    [{ ...base, app: "fastrouter", mode: undefined }, (a) => envFastrouter(parseFastrouter(a), {})],
    [{ ...base, app: "fastrouter", mode: undefined, reuseProxy: true }, (a) => envFastrouter(parseFastrouter(a), {})],
    [{ ...base, app: "fastrouter", mode: undefined, useProxy: false }, (a) => envFastrouter(parseFastrouter(a), {})],
    [{ ...base, app: "tokenharbor", mode: undefined }, (a) => envTokenharbor(parseTokenharbor(a), {})],
    [{ ...base, app: "tokenharbor", mode: undefined, reuseProxy: true }, (a) => envTokenharbor(parseTokenharbor(a), {})],
    [{ ...base, app: "tokenharbor", mode: undefined, useProxy: false }, (a) => envTokenharbor(parseTokenharbor(a), {})],
    [{ ...base, app: "groqcloud", mode: undefined }, (a) => envGroqcloud(parseGroqcloud(a), {})],
    [{ ...base, app: "groqcloud", mode: undefined, reuseProxy: true }, (a) => envGroqcloud(parseGroqcloud(a), {})],
    [{ ...base, app: "groqcloud", mode: undefined, useProxy: false }, (a) => envGroqcloud(parseGroqcloud(a), {})],
    [{ ...base, app: "webshare", mode: undefined, useProxy: undefined }, (a) => envWebshare(parseWebshare(a), {})],
  ];

  it("every plan produces the env the app would need", () => {
    for (const [plan, toEnv] of cases) {
      const env = toEnv(buildArgs(plan));
      expect(env.PACE).toBe(plan.pace);
      expect(env.HEADLESS).toBe(plan.headless ? "1" : "0");
      expect(env.INTER_ACCOUNT_DELAY_SEC).toBe(String(plan.delaySec));
      if (plan.app === "cbdg") expect(env.MODE).toBe(plan.mode);
      if (plan.useProxy !== undefined) expect(env.USE_PROXY).toBe(plan.useProxy ? "1" : "0");
      else expect(env.USE_PROXY).toBeUndefined();
      if (plan.reuseProxy !== undefined) expect(env.PROXY_REUSE).toBe(plan.reuseProxy ? "1" : "0");
    }
  });

  it("app entry paths exist for every app", async () => {
    for (const entry of Object.values(APP_ENTRY)) {
      expect(await Bun.file(entry).exists()).toBe(true);
    }
  });
});

describe("seeds + warnings", () => {
  function seedDir(gsuite: string, proxy: string, vcc: string, live = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "launch-"));
    writeFileSync(join(dir, "gsuite.txt"), gsuite);
    writeFileSync(join(dir, "proxy.txt"), proxy);
    writeFileSync(join(dir, "vcc.txt"), vcc);
    if (live) writeFileSync(join(dir, "proxy-live.txt"), live);
    return dir;
  }
  const seeds = (o: Partial<SeedInfo>): SeedInfo => ({ accounts: 5, proxies: 5, live: 5, liveAddresses: 5, cards: 2, ...o });

  it("counts seed lines and ignores comments and blanks", () => {
    const dir = seedDir("# c\na@x.com:p\n\nb@y.com:p\n", "http://1.1.1.1:80\n", "");
    expect(readSeeds(dir)).toEqual({ accounts: 2, proxies: 1, live: 0, liveAddresses: 0, cards: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts the checked pool separately from the raw harvest", () => {
    const dir = seedDir("a@x.com:p\n", "1.1.1.1:80\n2.2.2.2:80\n", "", "# header\n1.1.1.1:80\n");
    expect(readSeeds(dir)).toEqual({ accounts: 1, proxies: 2, live: 1, liveAddresses: 1, cards: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when full mode has no card", () => {
    expect(warningsFor({ ...base }, seeds({ cards: 0 })).join(" ")).toContain("vcc.txt kosong");
  });
  it("warns when there is no proxy at all", () => {
    const w = warningsFor({ ...base, mode: "signup" }, seeds({ proxies: 0, live: 0 }));
    expect(w.join(" ")).toContain("belum ada proxy");
  });
  it("warns when the harvest was never checked", () => {
    const w = warningsFor({ ...base, mode: "signup" }, seeds({ proxies: 7, live: 0 }));
    expect(w.join(" ")).toContain("belum dicek");
  });
  it("says nothing about checking once the live pool exists", () => {
    const w = warningsFor({ ...base, mode: "signup" }, seeds({ proxies: 7, live: 7 }));
    expect(w).toEqual([]);
  });
  it("warns about holding accounts back unless reuseProxy is set", () => {
    const held = warningsFor({ ...base, mode: "signup", reuseProxy: false }, seeds({ accounts: 10, liveAddresses: 4 }));
    expect(held.join(" ")).toContain("ditahan sampai ada proxy baru");
    const reuse = warningsFor({ ...base, mode: "signup", reuseProxy: true }, seeds({ accounts: 10, liveAddresses: 4 }));
    expect(reuse.join(" ")).toContain("reuse-proxy aktif");
    expect(reuse.join(" ")).not.toContain("ditahan");
  });
  it("warns when many accounts share one IP", () => {
    const w = warningsFor({ ...base, mode: "signup", useProxy: false }, seeds({ accounts: 9 }));
    expect(w.join(" ")).toContain("berbagi satu IP");
  });
  it("warns when spacing is zero", () => {
    const w = warningsFor({ ...base, mode: "signup", delaySec: 0 }, seeds({}));
    expect(w.join(" ")).toContain("0 detik");
  });
  it("proxy-capable list is exactly the apps that read the proxy file", () => {
    expect(PROXY_CAPABLE).toEqual(["cbdg", "crusoe", "fastrouter", "tokenharbor", "groqcloud", "llm7io", "inferbase"]);
  });

  it("getRemainingAccountsForApp differentiates ALREADY_REGISTERED based on requireApiKey", () => {
    const dir = mkdtempSync(join(tmpdir(), "rem-acc-"));
    writeFileSync(join(dir, "gsuite.txt"), "acc1@x.com:p\nacc2@x.com:p\nacc3@x.com:p\n");
    // acc1 has key, acc2 has ALREADY_REGISTERED, acc3 is not in results
    writeFileSync(
      join(dir, "akun-result-tokenharbor.txt"),
      "acc1@x.com:p:thk_12345678901234567890123456\nacc2@x.com:p:ALREADY_REGISTERED\n",
    );

    const withoutKey = getRemainingAccountsForApp("tokenharbor", dir, false);
    expect(withoutKey.total).toBe(3);
    expect(withoutKey.completed).toBe(2);
    expect(withoutKey.remaining).toBe(1);

    const withKey = getRemainingAccountsForApp("tokenharbor", dir, true);
    expect(withKey.total).toBe(3);
    expect(withKey.completed).toBe(1);
    expect(withKey.remaining).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("proxy-check as a menu action", () => {
  const plan: RunPlan = { ...base, app: "proxy-check", mode: undefined, useProxy: undefined };

  it("takes no run-shaping flags", () => {
    expect(buildArgs(plan)).toEqual([]);
    expect(commandLine(plan)).toBe("bun run proxy-check");
  });
  it("passes target and append flags when set", () => {
    const withFlags: RunPlan = { ...plan, proxyTarget: "https://tokenharbor.ai", proxyAppend: true };
    expect(buildArgs(withFlags)).toEqual(["--target", "https://tokenharbor.ai", "--append"]);
    expect(commandLine(withFlags)).toBe("bun run proxy-check -- --target https://tokenharbor.ai --append");
  });
  it("passes dedupe flags when dedupe action is chosen", () => {
    const dedupeAll: RunPlan = { ...plan, proxyDedupe: true, proxyDedupeTarget: "all", proxyFormatStyle: "url" };
    expect(buildArgs(dedupeAll)).toEqual(["--dedupe", "--all", "--style", "url"]);
    expect(commandLine(dedupeAll)).toBe("bun run proxy-check -- --dedupe --all --style url");

    const dedupeLive: RunPlan = { ...plan, proxyDedupe: true, proxyDedupeTarget: "proxy-live.txt", proxyFormatStyle: "colon" };
    expect(buildArgs(dedupeLive)).toEqual(["--dedupe", "--in", "proxy-live.txt", "--style", "colon"]);
  });
  it("is flagged as a tool, not an account run", () => {
    expect(IS_TOOL["proxy-check"]).toBe(true);
    expect(IS_TOOL.cbdg).toBe(false);
  });
  it("only warns about its own input", () => {
    expect(warningsFor(plan, { accounts: 0, proxies: 0, live: 0, liveAddresses: 0, cards: 0 })).toEqual([
      "proxy.txt kosong — jalankan webshare dulu.",
    ]);
    expect(warningsFor(plan, { accounts: 0, proxies: 3, live: 0, liveAddresses: 0, cards: 0 })).toEqual([]);
  });
});

describe("key-checker as a menu action", () => {
  const plan: RunPlan = { ...base, app: "key-checker", mode: undefined, useProxy: undefined };

  it("takes no run-shaping flags", () => {
    expect(buildArgs(plan)).toEqual([]);
    expect(commandLine(plan)).toBe("bun run key-checker");
  });
  it("is flagged as a tool, not an account run", () => {
    expect(IS_TOOL["key-checker"]).toBe(true);
  });
  it("has APP_ENTRY file on disk", async () => {
    expect(await Bun.file(APP_ENTRY["key-checker"]).exists()).toBe(true);
  });
  it("has no seed warnings", () => {
    expect(warningsFor(plan, { accounts: 0, proxies: 0, live: 0, liveAddresses: 0, cards: 0 })).toEqual([]);
  });
});

// ── bundle untuk VPS ───────────────────────────────────────────────
describe("runner-entry", () => {
  it("mengenali setiap app dan menolak yang lain", async () => {
    const { main } = await import("./runner-entry.js");
    const said: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (m: string) => said.push(String(m));
    console.error = (m: string) => said.push(String(m));
    try {
      // tanpa perintah → usage, exit 1
      expect(await main([])).toBe(1);
      expect(said.join(" ")).toContain("webshare");
      // perintah asing → usage, exit 1
      said.length = 0;
      expect(await main(["bogus"])).toBe(1);
      expect(said.join(" ")).toContain("tidak dikenal");
      // --help → usage, exit 0
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
    }
  });

  it("doctor ikut terdaftar sebagai perintah", async () => {
    const { main } = await import("./runner-entry.js");
    const said: string[] = [];
    const log = console.log;
    console.log = (m: string) => said.push(String(m));
    try {
      await main(["--help"]);
    } finally {
      console.log = log;
    }
    expect(said.join(" ")).toContain("doctor");
  });

  it("meneruskan flag ke app yang dipilih", async () => {
    const { main } = await import("./runner-entry.js");
    const said: string[] = [];
    const log = console.log;
    console.log = (m: string) => said.push(String(m));
    try {
      // --dry-run berhenti sebelum browser, jadi aman dipakai sebagai bukti
      // bahwa argumennya benar-benar sampai ke app-nya.
      expect(await main(["cbdg", "--dry-run", "--signup-only"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(said.join(" ")).toContain("dry-run");
    expect(said.join(" ")).toContain('"mode":"signup"');
  });
});
