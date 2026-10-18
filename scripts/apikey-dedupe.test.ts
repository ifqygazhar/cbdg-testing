import { describe, expect, it } from "bun:test";
import { parseLineToKeyRecord, dedupeLines, maskKey } from "./apikey-dedupe.js";

describe("parseLineToKeyRecord", () => {
  it("parses plain API keys", () => {
    const res = parseLineToKeyRecord("inf_eFwqF9i6iyUHYigvFFpKL-eNzZWX6zxGDTAjpZ0RH7-d85J9");
    expect(res).not.toBeNull();
    expect(res?.key).toBe("inf_eFwqF9i6iyUHYigvFFpKL-eNzZWX6zxGDTAjpZ0RH7-d85J9");
    expect(res?.hasCredentials).toBe(false);
  });

  it("parses account line with email:password:apikey", () => {
    const res = parseLineToKeyRecord(
      "benilami08@rurasa.my.id:cloudin123:thk_live_I4W6lTfaVucWExchM4C5-XCecvRgmZCggpdblk31cFkvPAqD4tFUAhnZJIhh6Du_"
    );
    expect(res).not.toBeNull();
    expect(res?.email).toBe("benilami08@rurasa.my.id");
    expect(res?.password).toBe("cloudin123");
    expect(res?.key).toBe("thk_live_I4W6lTfaVucWExchM4C5-XCecvRgmZCggpdblk31cFkvPAqD4tFUAhnZJIhh6Du_");
    expect(res?.hasCredentials).toBe(true);
  });

  it("parses account line with email:apikey", () => {
    const res = parseLineToKeyRecord("user@example.com:thk_live_1234567890abcdef");
    expect(res).not.toBeNull();
    expect(res?.email).toBe("user@example.com");
    expect(res?.key).toBe("thk_live_1234567890abcdef");
    expect(res?.hasCredentials).toBe(true);
  });

  it("strips trailing timestamp if present", () => {
    const res = parseLineToKeyRecord("inf_1234567890abcdef|2026-10-18T12:00:00Z");
    expect(res).not.toBeNull();
    expect(res?.key).toBe("inf_1234567890abcdef");
  });

  it("returns null for empty lines and comments", () => {
    expect(parseLineToKeyRecord("")).toBeNull();
    expect(parseLineToKeyRecord("   ")).toBeNull();
    expect(parseLineToKeyRecord("# This is a comment")).toBeNull();
    expect(parseLineToKeyRecord("// Another comment")).toBeNull();
  });
});

describe("dedupeLines", () => {
  it("removes duplicate identical keys", () => {
    const raw = [
      "inf_key1",
      "inf_key2",
      "inf_key1",
      "inf_key3",
      "inf_key2",
    ];
    const res = dedupeLines(raw, "smart");
    expect(res.cleanLines).toEqual(["inf_key1", "inf_key2", "inf_key3"]);
    expect(res.duplicateCount).toBe(2);
  });

  it("smart mode prefers richer credential line over plain key", () => {
    const raw = [
      "thk_live_111",
      "user@test.com:pass123:thk_live_111",
      "thk_live_222",
    ];
    const res = dedupeLines(raw, "smart");
    expect(res.cleanLines).toEqual([
      "user@test.com:pass123:thk_live_111",
      "thk_live_222",
    ]);
    expect(res.duplicateCount).toBe(1);
  });

  it("handles exact mode strictly line by line", () => {
    const raw = [
      "thk_live_111",
      "user@test.com:pass123:thk_live_111",
      "thk_live_111",
    ];
    const res = dedupeLines(raw, "exact");
    expect(res.cleanLines).toEqual([
      "thk_live_111",
      "user@test.com:pass123:thk_live_111",
    ]);
    expect(res.duplicateCount).toBe(1);
  });

  it("ignores blank lines and comments in duplicate calculation", () => {
    const raw = [
      "# Header comment",
      "",
      "inf_key1",
      "   ",
      "inf_key1",
      "// Footer",
    ];
    const res = dedupeLines(raw, "smart");
    expect(res.cleanLines).toEqual(["inf_key1"]);
    expect(res.duplicateCount).toBe(1);
    expect(res.emptyOrCommentLines).toBe(4);
  });
});

describe("maskKey", () => {
  it("masks keys longer than 16 chars", () => {
    const key = "thk_live_1234567890abcdefghijklmnopqrstuvwxyz";
    const masked = maskKey(key);
    expect(masked).toBe("thk_live_••••••••uvwxyz");
  });

  it("leaves short keys as-is", () => {
    expect(maskKey("short_key")).toBe("short_key");
  });
});
