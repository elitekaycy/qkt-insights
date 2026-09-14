import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
const DIGITS = 6;
const DRIFT_STEPS = 1;
/** RFC 4226 requires at least 128 bits of shared secret. */
const MIN_SECRET_BYTES = 16;

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) throw new Error("TOTP secret must be base32");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function codeForStep(key: Buffer, step: number, digits: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 code (HMAC-SHA1, 30-second step) for a base32 secret at a moment. */
export function totpAt(secretBase32: string, now: number, digits = DIGITS): string {
  return codeForStep(base32Decode(secretBase32), Math.floor(now / STEP_MS), digits);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secretBase32: string, account: string): string {
  const label = `qkt-insights:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=qkt-insights&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

/** Verifies six-digit codes with one step of clock drift; each step is accepted at most once. */
export class TotpVerifier {
  private readonly key: Buffer;
  private lastStep = -1;

  constructor(secretBase32: string) {
    this.key = base32Decode(secretBase32);
    if (this.key.length < MIN_SECRET_BYTES) throw new Error(`TOTP secret must decode to at least ${MIN_SECRET_BYTES} bytes`);
  }

  verify(code: string | undefined, now = Date.now()): boolean {
    if (!code || !/^\d{6}$/.test(code)) return false;
    const current = Math.floor(now / STEP_MS);
    const given = Buffer.from(code);
    for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
      if (step <= this.lastStep) continue;
      if (timingSafeEqual(Buffer.from(codeForStep(this.key, step, DIGITS)), given)) {
        this.lastStep = step;
        return true;
      }
    }
    return false;
  }
}
