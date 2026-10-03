import { describe, expect, it } from "bun:test";
import { TempMailClient } from "./tempmail.js";

describe("TempMailClient", () => {
  it("initializes with default options and env overrides", () => {
    const client = new TempMailClient({
      apiKey: "test-key",
      defaultDomain: "ifqy.net",
    });
    expect(client["apiKey"]).toBe("test-key");
    expect(client["defaultDomain"]).toBe("ifqy.net");
    expect(client["baseUrl"]).toBe("https://temp-postservice.verifwebsitepro.workers.dev");
  });

  it("extracts verification token link from message body using default regex", async () => {
    const client = new TempMailClient({ apiKey: "test-key" });
    const sampleLink = "https://tokenharbor.ai/verify-email?token=NmRiNzMyNzYtMGZhOC00YWYwLThmNjktN2I4ODNlNTA1Mjk5LjE3OTExMTQ4ODEzNjIueG9EemdBVDZjTktPWTJuRmlEN25OMXFuM1VEMUlVWE4wS1VQLXdUaVUwQQ";
    const sampleHtml = `<p>Click here: <a href="${sampleLink}">Verify email</a></p>`;

    // Mock getInbox
    client.getInbox = async () => [
      {
        id: "msg-1",
        sender: "verify@tokenharbor.ai",
        subject: "Verify your email to start using the Token Harbor API",
        "content-plain": `Verify here: ${sampleLink}`,
        "content-html": sampleHtml,
      },
    ];

    const link = await client.waitForVerificationLink("user@ifqy.net", { timeoutMs: 1000 });
    expect(link).toBe(sampleLink);
  });

  it("throws timeout if email does not arrive", async () => {
    const client = new TempMailClient({ apiKey: "test-key" });
    client.getInbox = async () => [];

    expect(client.waitForVerificationLink("user@ifqy.net", { timeoutMs: 200, intervalMs: 50 })).rejects.toThrow(
      "Timed out waiting for verification email",
    );
  });
});
