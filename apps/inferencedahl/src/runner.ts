// ── Per-account runner for Inference Dahl Global ───────────────────
import { launchGoogleOAuthBrowser } from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { InferenceDahlConfig } from "./config.js";
import { createLog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { runInferenceDahlFlow, type InferenceDahlSession } from "./flow/engine.js";

function parseProxyString(proxyStr: string | null | undefined) {
  if (!proxyStr) return null;
  try {
    let norm = proxyStr.trim();
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
    return {
      server: port ? `${protocol}//${u.hostname}:${port}` : `${protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { server: proxyStr };
  }
}

export async function runInferenceDahlAccount(
  sessionId: string | null,
  proxyStr: string | null,
  store: JsonlStore,
  results: ResultWriter,
  cfg: InferenceDahlConfig,
): Promise<{ success: boolean; id: string; fingerprint?: string; apiKey?: string; error?: string }> {
  const id = sessionId || `dahl-${randomBytes(4).toString("hex")}`;
  const log = createLog({ id });

  store.upsert({
    id,
    status: FlowState.PENDING,
    proxy: proxyStr ?? undefined,
    updatedAt: Date.now(),
  } as AccountRecord);

  const proxySpec = parseProxyString(proxyStr);
  log("info", "launching browser for Inference Dahl account", {
    id,
    proxy: proxySpec ? proxySpec.server : "direct",
    headless: cfg.headless,
  });

  let handle: Awaited<ReturnType<typeof launchGoogleOAuthBrowser>> | null = null;
  try {
    handle = await launchGoogleOAuthBrowser({
      proxy: proxySpec,
      headless: cfg.headless,
      opts: {
        screenShotDir: cfg.screenshotDir,
      },
    });

    const session: InferenceDahlSession = { id };
    const res = await runInferenceDahlFlow(handle.page, session, cfg, store, results, log);
    return {
      success: res.success,
      id,
      fingerprint: res.fingerprint,
      apiKey: res.apiKey,
      error: res.error,
    };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log("error", "fatal runner error", { id, error: msg });
    store.setStatus(id, FlowState.FAILED, msg);
    results.markFailed(id, msg);
    return { success: false, id, error: msg };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}
