/**
 * TempMail-Pro client for automated email creation, inbox polling, and verification link extraction.
 */

export interface TempMailConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultDomain?: string;
}

export interface CreatedEmail {
  email: string;
  username: string;
  domain: string;
  createdAt?: string;
}

export interface TempMessage {
  id: string;
  recipient?: string;
  sender: string;
  subject: string;
  "content-plain"?: string;
  "content-plain-formatted"?: string;
  "content-html"?: string;
  date?: string;
}

export interface InboxResponse {
  status: string;
  code: number;
  msg: string;
  address?: string;
  mails?: TempMessage[];
}

export class TempMailClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultDomain: string;

  constructor(config: TempMailConfig = {}) {
    let rawBase = config.baseUrl ?? process.env.TEMPMAIL_BASE_URL ?? "https://temp-postservice.verifwebsitepro.workers.dev";
    if (!rawBase.startsWith("http")) rawBase = `https://${rawBase}`;
    this.baseUrl = rawBase.replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.TEMPMAIL_API_KEY ?? "anjingmemekkontol";
    let dom = config.defaultDomain ?? process.env.TEMPMAIL_DOMAIN ?? "ifqy.net";
    if (dom.startsWith("temp.")) dom = dom.slice(5);
    this.defaultDomain = dom;
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  /**
   * Creates a new temporary email address.
   */
  async createEmail(domain?: string, username?: string): Promise<CreatedEmail> {
    let targetDomain = domain ?? this.defaultDomain;
    if (targetDomain.startsWith("temp.")) targetDomain = targetDomain.slice(5);
    if (targetDomain.includes("://")) {
      targetDomain = targetDomain.split("://")[1].split("/")[0];
      if (targetDomain.startsWith("temp.")) targetDomain = targetDomain.slice(5);
    }
    const body: Record<string, string> = { domain: targetDomain };
    if (username) body.username = username;

    const res = await fetch(`${this.baseUrl}/api/email/create`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`TempMail createEmail failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { status: string; data: { email: string; username: string; domain: string } };
    if (data.status !== "ok" || !data.data?.email) {
      throw new Error(`TempMail createEmail unexpected response: ${JSON.stringify(data)}`);
    }

    return {
      email: data.data.email,
      username: data.data.username,
      domain: data.data.domain,
    };
  }

  /**
   * Fetches current messages for an email address.
   */
  async getInbox(address: string): Promise<TempMessage[]> {
    const url = `${this.baseUrl}/api/email/inbox?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": this.apiKey },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`TempMail getInbox failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as InboxResponse;
    return data.mails ?? [];
  }

  /**
   * Polls the inbox until a message matching criteria arrives, and extracts the verification URL.
   */
  async waitForVerificationLink(
    address: string,
    opts: {
      timeoutMs?: number;
      intervalMs?: number;
      filterSender?: string;
      linkRegex?: RegExp;
    } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 75000;
    const intervalMs = opts.intervalMs ?? 3000;
    const filterSender = (opts.filterSender ?? "").toLowerCase().trim();
    const linkRegex = opts.linkRegex ?? /https?:\/\/[^\s"'<>]+verify[^\s"'<>]+/;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const mails = await this.getInbox(address);
        for (const mail of mails) {
          const senderMatches = !filterSender || mail.sender.toLowerCase().includes(filterSender);
          if (senderMatches) {
            const body = `${mail["content-plain"] ?? ""} ${mail["content-html"] ?? ""}`;
            const match = body.match(linkRegex);
            if (match) {
              return match[0].replace(/[\)>\]"'.,]+$/, "");
            }
          }
        }
      } catch (e) {
        // Tolerates temporary network glitch during polling
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for verification email on ${address} after ${Math.round(timeoutMs / 1000)}s`);
  }

  /**
   * Polls the inbox until a verification message arrives, and extracts the 6-digit OTP verification code.
   */
  async waitForVerificationOtp(
    address: string,
    optsOrTimeout:
      | number
      | {
          timeoutMs?: number;
          intervalMs?: number;
          filterSender?: string;
          codeRegex?: RegExp;
        } = {},
    legacyInterval?: number,
    legacyFilterSender?: string,
  ): Promise<string> {
    const opts =
      typeof optsOrTimeout === "number"
        ? {
            timeoutMs: optsOrTimeout > 1000 ? optsOrTimeout : optsOrTimeout * 1000,
            intervalMs: legacyInterval ? (legacyInterval > 1000 ? legacyInterval : legacyInterval * 1000) : 3000,
            filterSender: legacyFilterSender,
          }
        : optsOrTimeout;

    const timeoutMs = opts.timeoutMs ?? 75000;
    const intervalMs = opts.intervalMs ?? 3000;
    const filterSender = (opts.filterSender ?? "").toLowerCase();

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const mails = await this.getInbox(address);
        for (const mail of mails) {
          const senderMatches = !filterSender || mail.sender.toLowerCase().includes(filterSender);
          if (senderMatches) {
            const body = `${mail.subject ?? ""} ${mail["content-plain"] ?? ""} ${mail["content-html"] ?? ""}`;
            // 1. Try matching bold 6 digits inside <b> tags in html (e.g. Clerk / FastRouter templates)
            const mBold = body.match(/<(?:b|strong|span|div)[^>]*>\s*(\d{6})\s*<\/(?:b|strong|span|div)>/i);
            if (mBold && mBold[1]) return mBold[1];

            // 2. Strip HTML tags and collapse whitespace to avoid false positives and distance issues
            const cleanText = body.replace(/<[^>]+>/g, " ");
            const normText = cleanText.replace(/\s+/g, " ");
            const mPrompt = normText.match(/(?:verification code|temporary verification code|code to continue|enter this temporary|enter the following|code when prompted)[\s\S]{0,400}?(\d{6})/i);
            if (mPrompt && mPrompt[1]) return mPrompt[1];

            // 3. Match explicit codeRegex or standalone 6-digit number
            if (opts.codeRegex) {
              const mCustom = normText.match(opts.codeRegex) || cleanText.match(opts.codeRegex);
              if (mCustom) {
                const code = mCustom[1] || mCustom[0];
                if (/^\d{6}$/.test(code)) return code;
              }
            } else {
              const mAny = normText.match(/\b(\d{6})\b/);
              if (mAny && mAny[1]) return mAny[1];
            }
          }
        }
      } catch (e) {
        // Tolerates temporary network glitch during polling
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for verification code on ${address} after ${Math.round(timeoutMs / 1000)}s`);
  }

  /**
   * Deletes a temporary email and all its messages.
   */
  async deleteEmail(address: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/email/delete?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "x-api-key": this.apiKey },
    });
    return res.ok;
  }
}
