// ── Seed loaders ───────────────────────────────────────────────────
import fs from "node:fs";

export interface GsuiteAccount {
  email: string;
  password: string;
  raw: string;
}
export interface VccCard {
  cardNumber: string;
  expiry: string; // MM/YY or MM/YYYY (kept raw; validated)
  cvv: string;
  raw: string;
}
export interface ProxySeed {
  server: string; // e.g. http://host:port
  /**
   * Credentials live apart from `server` because that is what Chrome needs:
   * the --proxy-server flag takes no user:pass, the password goes through
   * `page.authenticate`. Folding them into `server` (or dropping them, as this
   * used to) makes every navigation fail with ERR_INVALID_AUTH_CREDENTIALS.
   */
  username?: string;
  password?: string;
  raw: string;
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// gsuite.txt   →  email:password
export function loadAccounts(file: string): GsuiteAccount[] {
  const out: GsuiteAccount[] = [];
  for (const line of readLines(file)) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      console.warn(`[loaders] skip bad gsuite line: ${line}`);
      continue;
    }
    out.push({
      email: line.slice(0, idx).trim(),
      password: line.slice(idx + 1).trim(),
      raw: line,
    });
  }
  return out;
}

// vcc.txt   →  card number | exp date | cvv
const EXPIRY_RE = /^\d{2}\/\d{2}(?:\d{2})?$/;
export function loadCards(file: string): VccCard[] {
  const out: VccCard[] = [];
  for (const line of readLines(file)) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3 || !EXPIRY_RE.test(parts[1]) || !/^\d{3,4}$/.test(parts[2])) {
      console.warn(`[loaders] skip bad vcc line: ${line}`);
      continue;
    }
    out.push({ cardNumber: parts[0], expiry: parts[1], cvv: parts[2], raw: line });
  }
  return out;
}

// proxy.txt   →  (scheme://)host:port or http://user:pass@host:port
export function loadProxies(file: string): ProxySeed[] {
  const out: ProxySeed[] = [];
  for (const line of readLines(file)) {
    try {
      let norm = line.trim();
      if (!norm.includes("://")) {
        const parts = norm.split(":");
        if (parts.length === 4) {
          norm = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
        } else {
          norm = `http://${norm}`;
        }
      }
      const u = new URL(norm);
      let port = u.port;
      if (!port) {
        const authority = norm.split("://")[1]?.split("/")[0] || "";
        const hostPart = authority.includes("@") ? authority.split("@")[1] : authority;
        const m = hostPart.match(/:(\d+)$/);
        if (m) port = m[1];
      }
      let protocol = u.protocol.toLowerCase();
      if (protocol === "socks5h:" || protocol === "socks5:") {
        protocol = "socks5:";
      } else if (protocol === "socks4a:" || protocol === "socks4:" || protocol === "socks:") {
        protocol = "socks4:";
      }
      out.push({
        server: port ? `${protocol}//${u.hostname}:${port}` : `${protocol}//${u.host}`,
        // URL-encodes them on the way in (see the webshare writer), so decode.
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        raw: line,
      });
    } catch {
      console.warn(`[loaders] skip bad proxy line: ${line}`);
    }
  }
  return out;
}