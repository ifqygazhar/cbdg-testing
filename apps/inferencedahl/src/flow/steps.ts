// ── Granular step functions for Inference Dahl Global (Puppeteer/Bun) ──
import type { Page } from "puppeteer-core";
import {
  SELECTORS,
  DAHL_FINGERPRINT_REGEX,
  DAHL_KEY_REGEX,
  DEMO_LANDING_KEY,
} from "./selectors.js";
import type { ULog } from "../log.js";

export function isValidDahlApiKey(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (trimmed === DEMO_LANDING_KEY) return false;
  if (trimmed.includes("…") || trimmed.includes("...")) return false;
  return DAHL_KEY_REGEX.test(trimmed);
}

export async function installCredentialHooks(page: Page): Promise<{
  getCaptured: () => { fingerprint?: string; apiKey?: string; username?: string };
}> {
  const captured: { fingerprint?: string; apiKey?: string; username?: string } = {};

  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (url.includes("/v1/auth/signup") && resp.request().method() === "POST" && resp.status() === 200) {
        const data = (await resp.json()) as any;
        if (data?.fingerprint && DAHL_FINGERPRINT_REGEX.test(data.fingerprint)) {
          captured.fingerprint = data.fingerprint;
        }
        const tok = data?.api_key?.token || data?.apiKey || data?.token;
        if (isValidDahlApiKey(tok)) {
          captured.apiKey = tok.trim();
        }
        if (data?.user?.username) {
          captured.username = data.user.username;
        }
      } else if (url.includes("/v1/account/keys") && resp.status() === 200) {
        const data = (await resp.json()) as any;
        const keys = Array.isArray(data?.keys) ? data.keys : data?.key ? [data.key] : [];
        for (const k of keys) {
          if (isValidDahlApiKey(k?.token)) {
            captured.apiKey = k.token.trim();
            break;
          }
        }
      }
    } catch {
      /* ignore non-JSON responses */
    }
  });

  const hookScript = () => {
    (window as any).__dahl_clipboard = [];
    (window as any).__dahl_blobs = [];
    try {
      if (navigator.clipboard) {
        const origWrite = navigator.clipboard.writeText?.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text: string) => {
          (window as any).__dahl_clipboard.push(String(text));
          if (origWrite) {
            try {
              return await origWrite(text);
            } catch {
              return;
            }
          }
        };
      }
    } catch {}
    try {
      const OrigBlob = window.Blob;
      (window as any).Blob = function (parts: any[], options?: BlobPropertyBag) {
        try {
          if (Array.isArray(parts)) {
            (window as any).__dahl_blobs.push(parts.map((p) => String(p)).join("\n"));
          }
        } catch {}
        return new OrigBlob(parts, options);
      } as any;
      (window as any).Blob.prototype = OrigBlob.prototype;
    } catch {}
  };

  await page.evaluateOnNewDocument(hookScript);
  await page.evaluate(hookScript).catch(() => {});

  return {
    getCaptured: () => captured,
  };
}

export async function stepOpenSignupModal(page: Page, logger: ULog): Promise<void> {
  logger("info", "navigating to Inference Dahl landing page", { url: SELECTORS.landing.url });
  await page.goto(SELECTORS.landing.url, { waitUntil: "domcontentloaded", timeout: 40000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Click SIGN IN if modal not yet open
  const hasDialog = await page.$(SELECTORS.signinModal.dialog);
  if (!hasDialog) {
    logger("info", "clicking SIGN IN to open auth modal...");
    await page.evaluate(() => {
      const link =
        (document.querySelector('a[data-auth="guest"]') as HTMLElement) ||
        (Array.from(document.querySelectorAll("a, button")).find((el) =>
          /sign\s*in/i.test(el.textContent || ""),
        ) as HTMLElement);
      if (link) link.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
  }

  // If still no dialog, navigate to /account which automatically opens the sign-in modal
  if (!(await page.$(SELECTORS.signinModal.dialog))) {
    logger("info", "navigating to /account to trigger auth modal...");
    await page.goto(SELECTORS.dashboard.url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Switch from Welcome back (Sign in) to Create your account
  const isSignupOpen = await page.$(SELECTORS.signupModal.usernameInput);
  if (!isSignupOpen) {
    logger("info", "switching modal from Sign in to Create account...");
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const btns = Array.from(dialog.querySelectorAll('button[type="button"], button'));
      const btn = btns.find((b) =>
        /create\s*account/i.test((b.textContent || "").trim()) &&
        (b as HTMLElement).offsetParent !== null &&
        window.getComputedStyle(b).display !== "none"
      ) || btns.find((b) =>
        /create\s*account/i.test((b.textContent || "").trim())
      ) as HTMLButtonElement | undefined;
      if (btn) (btn as HTMLElement).click();
    });
  }

  await page.waitForSelector(SELECTORS.signupModal.usernameInput, { timeout: 15000 });
}

export async function stepFocusUsernameAndSubmitSignup(
  page: Page,
  logger: ULog,
): Promise<string> {
  logger("info", "clicking auto-generated username input to activate Create account button...");

  let username = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.waitForSelector(SELECTORS.signupModal.usernameInput, { timeout: 10000 });
    await page.click(SELECTORS.signupModal.usernameInput);
    await new Promise((r) => setTimeout(r, 600));

    // Wait up to 4s for username availability check to finish and submit button to enable
    const start = Date.now();
    let enabled = false;
    while (Date.now() - start < 4000) {
      const state = await page.evaluate(() => {
        const inp = document.querySelector("input#signup-username") as HTMLInputElement | null;
        const btn = document.querySelector('form button[type="submit"]') as HTMLButtonElement | null;
        const dialogText = document.querySelector('[role="dialog"]')?.textContent || "";
        return {
          val: inp?.value?.trim() || "",
          disabled: !btn || btn.disabled,
          taken: /taken|already/i.test(dialogText),
        };
      });
      username = state.val;
      if (username && !state.disabled) {
        enabled = true;
        break;
      }
      if (state.taken) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    if (enabled) break;

    logger("info", `username '${username}' not ready/taken on attempt ${attempt}, clicking Regenerate...`);
    await page.evaluate(() => {
      const regen = document.querySelector('button[aria-label="Regenerate"]') as HTMLButtonElement | null;
      if (regen) regen.click();
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  logger("info", "submitting Create account with auto-generated username", { username });
  await page.click(SELECTORS.signupModal.submitButton);
  return username;
}

export async function stepExtractFingerprintAndApiKeyAfterSignup(
  page: Page,
  getCaptured: () => { fingerprint?: string; apiKey?: string; username?: string },
  logger: ULog,
): Promise<{ fingerprint: string; apiKey: string }> {
  logger("info", "waiting for 'Save your fingerprint' modal...");

  const start = Date.now();
  while (Date.now() - start < 20000) {
    const hasSaveModal = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? /save your fingerprint/i.test(d.textContent || "") : false;
    });
    if (hasSaveModal) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  // Click Copy buttons and Download as .txt to populate hooks as fallback
  await page.evaluate(async () => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const copyBtns = Array.from(dialog.querySelectorAll('button[aria-label="Copy"]')) as HTMLButtonElement[];
    for (const b of copyBtns) {
      b.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    const dlBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /download as \.txt/i.test(b.textContent || ""),
    ) as HTMLButtonElement | undefined;
    if (dlBtn) dlBtn.click();
  });

  await new Promise((r) => setTimeout(r, 400));

  const domExtracted = await page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('[role="dialog"] code')).map((c) =>
      (c.textContent || "").trim(),
    );
    const clip = ((window as any).__dahl_clipboard || []) as string[];
    const blobs = ((window as any).__dahl_blobs || []) as string[];
    return { codes, clip, blobs };
  });

  const net = getCaptured();
  let fingerprint = net.fingerprint || "";
  let apiKey = net.apiKey || "";

  // Check codes/clipboard/blobs for fingerprint
  if (!fingerprint) {
    for (const src of [...domExtracted.codes, ...domExtracted.clip, ...domExtracted.blobs]) {
      const m = src.match(DAHL_FINGERPRINT_REGEX);
      if (m) {
        fingerprint = m[0];
        break;
      }
    }
  }

  // Check clipboard/blobs/codes for full unmasked dahl_ key
  if (!isValidDahlApiKey(apiKey)) {
    for (const src of [...domExtracted.clip, ...domExtracted.blobs, ...domExtracted.codes]) {
      const matches = src.match(/\bdahl_[A-Za-z0-9_-]{16,}\b/g) || [];
      for (const cand of matches) {
        if (isValidDahlApiKey(cand)) {
          apiKey = cand;
          break;
        }
      }
      if (isValidDahlApiKey(apiKey)) break;
    }
  }

  // Check the "I saved my fingerprint" checkbox and click Continue
  logger("info", "checking 'I saved my fingerprint' checkbox and clicking Continue...");
  await page.evaluate(() => {
    const cb = document.querySelector('input.auth-checkbox[type="checkbox"]') as HTMLInputElement | null;
    if (cb && !cb.checked) {
      cb.click();
    }
  });
  await new Promise((r) => setTimeout(r, 400));

  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const contBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => /continue/i.test((b.textContent || "").trim()) && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    if (contBtn) contBtn.click();
  });

  await new Promise((r) => setTimeout(r, 1200));

  return { fingerprint, apiKey };
}

export async function stepEnsureAccountDashboardAndAllocate(
  page: Page,
  currentApiKey: string,
  getCaptured: () => { fingerprint?: string; apiKey?: string; username?: string },
  logger: ULog,
): Promise<string> {
  if (!page.url().includes("/account")) {
    logger("info", "navigating to https://inference.dahl.global/account...");
    await page.goto(SELECTORS.dashboard.url, { waitUntil: "domcontentloaded", timeout: 35000 });
  }

  await page.waitForSelector(SELECTORS.dashboard.apiKeysSection, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1000));

  let apiKey = currentApiKey;

  // If full API key was not yet obtained, reveal/copy it from the API keys section
  if (!isValidDahlApiKey(apiKey)) {
    const net = getCaptured();
    if (isValidDahlApiKey(net.apiKey)) {
      apiKey = net.apiKey;
    }
  }

  if (!isValidDahlApiKey(apiKey)) {
    logger("info", "revealing full API key from /account dashboard...");
    await page.evaluate(async () => {
      const sec = document.querySelector('section[aria-label="API keys"]');
      if (!sec) return;
      const revealBtn = sec.querySelector('button[aria-label="Reveal"]') as HTMLButtonElement | null;
      if (revealBtn) revealBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const copyBtn = sec.querySelector('button[aria-label="Copy"]') as HTMLButtonElement | null;
      if (copyBtn) copyBtn.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    const dashExtracted = await page.evaluate(() => {
      const codeText = document.querySelector('section[aria-label="API keys"] code')?.textContent?.trim() || "";
      const clip = ((window as any).__dahl_clipboard || []) as string[];
      return { codeText, clip };
    });

    for (const cand of [dashExtracted.codeText, ...dashExtracted.clip]) {
      const m = cand.match(DAHL_KEY_REGEX);
      if (m && isValidDahlApiKey(m[0])) {
        apiKey = m[0];
        break;
      }
    }
  }

  // Check if already Active with 100M allocated
  const alreadyAllocated = await page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="API keys"]');
    if (!sec) return false;
    const text = sec.textContent || "";
    return /Active/i.test(text) && /100(\.0)?M\s*\/\s*100(\.0)?M/i.test(text);
  });

  if (alreadyAllocated) {
    logger("info", "API key already Active with 100M/100M allocated!");
    return apiKey;
  }

  // Click Allocate button on the key card
  logger("info", "clicking Allocate button on API key card...");
  const clickedAllocateCard = await page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="API keys"]');
    if (!sec) return false;
    const btn = Array.from(sec.querySelectorAll('button[type="button"]')).find(
      (b) => /^allocate$/i.test((b.textContent || "").trim()) && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!clickedAllocateCard) {
    throw new Error("Could not find enabled 'Allocate' button in API keys section");
  }

  // Wait for 'Allocate to key' dialog
  logger("info", "waiting for 'Allocate to key' modal popup...");
  const modalStart = Date.now();
  let modalOpen = false;
  while (Date.now() - modalStart < 10000) {
    modalOpen = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? /allocate to key/i.test(d.textContent || "") : false;
    });
    if (modalOpen) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!modalOpen) {
    throw new Error("'Allocate to key' modal did not appear");
  }

  // Click Max button inside modal
  logger("info", "clicking 'Max' button inside Allocate modal...");
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return;
    const maxBtn = Array.from(d.querySelectorAll('button[type="button"]')).find((b) =>
      /^max$/i.test((b.textContent || "").trim()),
    ) as HTMLButtonElement | undefined;
    if (maxBtn) maxBtn.click();
  });

  await new Promise((r) => setTimeout(r, 500));

  // Click Allocate confirm button inside modal
  logger("info", "clicking 'Allocate' confirm button inside modal...");
  const confirmed = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return false;
    const allocBtn = Array.from(d.querySelectorAll('button[type="button"]')).find(
      (b) => /^allocate$/i.test((b.textContent || "").trim()) && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    if (allocBtn) {
      allocBtn.click();
      return true;
    }
    return false;
  });

  if (!confirmed) {
    throw new Error("Modal 'Allocate' confirm button remained disabled after clicking Max");
  }

  // Wait for allocation to complete (Active and 100M/100M visible in API keys section)
  logger("info", "verifying Active status and 100M token allocation...");
  const verifyStart = Date.now();
  let allocationVerified = false;
  while (Date.now() - verifyStart < 15000) {
    allocationVerified = await page.evaluate(() => {
      const sec = document.querySelector('section[aria-label="API keys"]');
      if (!sec) return false;
      const text = sec.textContent || "";
      return /Active/i.test(text) && /100(\.0)?M/i.test(text);
    });
    if (allocationVerified) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!allocationVerified) {
    throw new Error("Token allocation verification timed out (Active + 100M not detected)");
  }

  logger("info", "token allocation verified: Active (100M/100M)!");
  return apiKey;
}
