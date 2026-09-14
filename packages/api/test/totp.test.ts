import { describe, it, expect } from "vitest";
import { TotpVerifier, base32Encode, generateTotpSecret, totpAt, totpUri } from "../src/totp.js";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", 8 digits.
const RFC_SECRET_BASE32 = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totpAt(RFC_SECRET_BASE32, 59_000, 8)).toBe("94287082");
    expect(totpAt(RFC_SECRET_BASE32, 1_111_111_109_000, 8)).toBe("07081804");
    expect(totpAt(RFC_SECRET_BASE32, 2_000_000_000_000, 8)).toBe("69279037");
  });

  it("accepts the current code and one step of drift, then refuses a replay", () => {
    const now = 1_700_000_000_000;
    const v = new TotpVerifier(RFC_SECRET_BASE32);
    expect(v.verify(totpAt(RFC_SECRET_BASE32, now - 30_000), now)).toBe(true);
    expect(v.verify(totpAt(RFC_SECRET_BASE32, now - 30_000), now)).toBe(false);
    expect(v.verify(totpAt(RFC_SECRET_BASE32, now), now)).toBe(true);
    expect(v.verify(totpAt(RFC_SECRET_BASE32, now), now)).toBe(false);
  });

  it("refuses codes outside the drift window and malformed input", () => {
    const now = 1_700_000_000_000;
    const v = new TotpVerifier(RFC_SECRET_BASE32);
    expect(v.verify(totpAt(RFC_SECRET_BASE32, now - 90_000), now)).toBe(false);
    expect(v.verify("12345", now)).toBe(false);
    expect(v.verify("abcdef", now)).toBe(false);
    expect(v.verify(undefined, now)).toBe(false);
  });

  it("generates a 160-bit base32 secret and an authenticator URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri(secret, "forward")).toBe(`otpauth://totp/qkt-insights:forward?secret=${secret}&issuer=qkt-insights&algorithm=SHA1&digits=6&period=30`);
  });

  it("rejects a secret that is not base32", () => {
    expect(() => new TotpVerifier("not base32!")).toThrow();
  });

  it("rejects a secret shorter than 128 bits", () => {
    expect(() => new TotpVerifier("A")).toThrow("at least 16 bytes");
    expect(() => new TotpVerifier(base32Encode(Buffer.alloc(15, 7)))).toThrow("at least 16 bytes");
    expect(() => new TotpVerifier(base32Encode(Buffer.alloc(16, 7)))).not.toThrow();
  });
});
