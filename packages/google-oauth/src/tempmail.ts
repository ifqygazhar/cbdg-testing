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
    this.baseUrl = (config.baseUrl ?? process.env.TEMPMAIL_BASE_URL ?? "https://temp-postservice.verifwebsitepro.workers.dev").replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.TEMPMAIL_API_KEY ?? "anjingmemekkontol";
    this.defaultDomain = config.defaultDomain ?? process.env.TEMPMAIL_DOMAIN ?? "ifqy.net";
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
    const targetDomain = domain ?? this.defaultDomain;
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
    const filterSender = (opts.filterSender ?? "tokenharbor").toLowerCase();
    const linkRegex = opts.linkRegex ?? /https:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9_\-]+/;

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
              return match[0];
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
