// ── Proxy checker: the parts that must not guess ───────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSocks,
  decodeChunked,
  judge,
  mask,
  parseProxyFile,
  parseProxyLine,
  pool,
  readExitIp,
  sortByLatency,
  summarise,
  type CheckResult,
} from "./proxy-lib.js";
import { renderLiveFile, parseArgs } from "./proxy-check.js";
import { loadProxies } from "../apps/crusoe/src/loaders.js";

const entry = (hostPort: string) => ({
  raw: `http://u:p@${hostPort}`,
  url: `http://u:p@${hostPort}`,
  hostPort,
  protocol: "http:",
  hostname: hostPort.split(":")[0],
  port: hostPort.split(":")[1],
  username: "u",
  password: "p",
});
const result = (hostPort: string, ms: number, alive = true): CheckResult => ({
  entry: entry(hostPort),
  alive,
  ms,
  exitIp: alive ? hostPort.split(":")[0] : undefined,
});

describe("parsing", () => {
  it("accepts both shapes the harvest can produce", () => {
    expect(parseProxyLine("http://u:p@1.2.3.4:8080")?.hostPort).toBe("1.2.3.4:8080");
    expect(parseProxyLine("5.6.7.8:3128")?.url).toBe("http://5.6.7.8:3128");
  });
  it("accepts credential-less HTTPS and custom/default ports", () => {
    const p1 = parseProxyLine("https://37.203.35.19:443");
    expect(p1?.hostPort).toBe("37.203.35.19:443");
    expect(p1?.protocol).toBe("https:");
    expect(p1?.username).toBeUndefined();

    const p2 = parseProxyLine("https://37.203.35.25:443");
    expect(p2?.hostPort).toBe("37.203.35.25:443");
    expect(p2?.url).toBe("https://37.203.35.25:443");
  });
  it("accepts socks4, socks5, and host:port:user:pass formats", () => {
    const s4 = parseProxyLine("socks4://1.2.3.4:1080");
    expect(s4?.protocol).toBe("socks4:");
    expect(s4?.hostPort).toBe("1.2.3.4:1080");

    const s5 = parseProxyLine("socks5://usr:pwd@5.6.7.8:1080");
    expect(s5?.protocol).toBe("socks5:");
    expect(s5?.username).toBe("usr");
    expect(s5?.password).toBe("pwd");

    const hpup = parseProxyLine("10.0.0.1:8080:alice:bob");
    expect(hpup?.url).toBe("http://alice:bob@10.0.0.1:8080");
    expect(hpup?.username).toBe("alice");
    expect(hpup?.password).toBe("bob");
  });
  it("rejects what cannot be dialled", () => {
    expect(parseProxyLine("bukan-proxy")).toBeNull();
    expect(parseProxyLine("http://host-tanpa-port")).toBeNull();
    expect(parseProxyLine("# komentar")).toBeNull();
    expect(parseProxyLine("")).toBeNull();
  });
  it("skips comments and blanks, and keeps one entry per endpoint", () => {
    const { entries, skipped, duplicates } = parseProxyFile(
      ["# header", "", "http://u:p@1.2.3.4:80", "http://other:x@1.2.3.4:80", "5.6.7.8:1", "rusak"].join("\n"),
    );
    expect(entries.map((e) => e.hostPort)).toEqual(["1.2.3.4:80", "5.6.7.8:1"]);
    expect(skipped).toEqual(["rusak"]);
    expect(duplicates).toBe(1);
  });
  it("ignores duplicate IP and port across different protocols or auth shapes", () => {
    const lines = [
      "1.2.3.4:8080",
      "http://1.2.3.4:8080",
      "http://user:pass@1.2.3.4:8080",
      "socks5://other:pass@1.2.3.4:8080",
      "1.2.3.4:8080:alice:secret",
      "bob:pass:1.2.3.4:8080",
    ].join("\n");
    const { entries, duplicates } = parseProxyFile(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0].hostPort).toBe("1.2.3.4:8080");
    expect(duplicates).toBe(5);
    // Verified that authenticated duplicate upgraded the bare first line
    expect(entries[0].username).toBeDefined();
  });
  it("mask hides the password but keeps the endpoint readable", () => {
    expect(mask("http://user:s3cret@1.2.3.4:8080")).toBe("http://user:***@1.2.3.4:8080");
    expect(mask("socks5://admin:pass123@1.2.3.4:1080")).toBe("socks5://admin:***@1.2.3.4:1080");
    expect(mask("1.2.3.4:8080:admin:pass123")).toBe("1.2.3.4:8080:admin:***");
    expect(mask("https://37.203.35.19:443")).toBe("https://37.203.35.19:443");
    expect(mask("1.2.3.4:8080")).toBe("1.2.3.4:8080");
  });
});

describe("verdict", () => {
  it("only an IP answer counts", () => {
    expect(readExitIp(" 1.2.3.4 \n")).toBe("1.2.3.4");
    expect(readExitIp("<html>blocked</html>")).toBeNull();
  });
  it("a proxy that leaks our own IP is dead, not alive", () => {
    // The dangerous case: a proxy that silently falls through to a direct
    // connection would otherwise pass and every account would share our IP.
    expect(judge("9.9.9.9", "1.1.1.1").alive).toBe(true);
    expect(judge("1.1.1.1", "1.1.1.1").alive).toBe(false);
    expect(judge(null, "1.1.1.1").alive).toBe(false);
  });
  it("without a known direct IP we do not invent a failure", () => {
    expect(judge("9.9.9.9", null).alive).toBe(true);
  });
});

describe("ordering + summary", () => {
  it("fastest first, because the queue hands them out in file order", () => {
    const sorted = sortByLatency([result("a:1", 900), result("b:2", 100), result("c:3", 500)]);
    expect(sorted.map((r) => r.ms)).toEqual([100, 500, 900]);
  });
  it("summarise counts and takes the median of the live ones", () => {
    const s = summarise([result("a:1", 100), result("b:2", 300), result("c:3", 900), result("d:4", 0, false)]);
    expect(s).toEqual({ alive: 3, dead: 1, medianMs: 300 });
  });
});

describe("pool", () => {
  it("keeps order and respects the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it("an empty list is not a stall", async () => {
    expect(await pool([], 4, async () => 1)).toEqual([]);
  });
});

describe("output file", () => {
  const opts = parseArgs([], process.cwd());

  it("every written line is parseable by the apps' loader", () => {
    // Regression: annotating each line with "# 120ms" made the whole file
    // unparseable, because loadProxies runs `new URL()` per line.
    const alive = [result("1.2.3.4:8080", 100), result("5.6.7.8:3128", 200)];
    const dir = mkdtempSync(join(tmpdir(), "pxy-"));
    const file = join(dir, "proxy-live.txt");
    writeFileSync(file, renderLiveFile(alive, opts, 5), "utf8");
    const loaded = loadProxies(file);
    expect(loaded.map((p) => p.server)).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("the header says where it came from and how many passed", () => {
    const text = renderLiveFile([result("1.2.3.4:8080", 100)], opts, 4);
    expect(text.split("\n")[1]).toContain("1/4 lolos");
    expect(text.split("\n").filter((l) => l && !l.startsWith("#"))).toHaveLength(1);
  });
});

describe("options", () => {
  it("defaults read proxy.txt and write proxy-live.txt", () => {
    const o = parseArgs([], "/tmp/x");
    expect(o.input.endsWith("proxy.txt")).toBe(true);
    expect(o.output.endsWith("proxy-live.txt")).toBe(true);
    expect(o.force).toBe(false);
    expect(o.append).toBe(false);
  });
  it("flags override the defaults", () => {
    const o = parseArgs(["--in", "a.txt", "--out", "b.txt", "--timeout", "3", "-c", "4", "--force", "--append"], "/tmp/x");
    expect(o.input.endsWith("a.txt")).toBe(true);
    expect(o.output.endsWith("b.txt")).toBe(true);
    expect(o.timeoutMs).toBe(3000);
    expect(o.concurrency).toBe(4);
    expect(o.force).toBe(true);
    expect(o.append).toBe(true);
  });
  it("-a flag enables append mode", () => {
    const o = parseArgs(["-a"], "/tmp/x");
    expect(o.append).toBe(true);
  });
  it("-s and --skip-existing flags enable skipExisting mode", () => {
    expect(parseArgs(["-s"], "/tmp/x").skipExisting).toBe(true);
    expect(parseArgs(["--skip-existing"], "/tmp/x").skipExisting).toBe(true);
  });
});

describe("chunked decoding", () => {
  it("decodes valid chunked responses", () => {
    const chunked = "d\r\nHello, world!\r\n0\r\n\r\n";
    expect(decodeChunked(chunked)).toBe("Hello, world!");
  });
});

describe("socks checking", () => {
  it("marks invalid or unreachable socks proxy as dead with a reason", async () => {
    const entry = parseProxyLine("socks5://127.0.0.1:59998")!;
    const res = await checkSocks(entry, { url: "http://ipv4.webshare.io/", timeoutMs: 500 }, null);
    expect(res.alive).toBe(false);
    expect(res.reason).toBeDefined();
  });
});
