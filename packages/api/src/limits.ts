/** Fixed-window hit counter per key. In memory: limits reset on restart, which is acceptable for throttling. */
export class WindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Counts a hit; false once the key has used its budget for the current window. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  count(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    return w && now - w.start < this.windowMs ? w.count : 0;
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    return w ? Math.max(0, w.start + this.windowMs - now) : 0;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }

  get size(): number {
    return this.windows.size;
  }
}

export interface LoginGuardOptions { perIpFailures: number; globalFailures: number; windowMs: number; lockMs: number }

export const LOGIN_GUARD_DEFAULTS: LoginGuardOptions = { perIpFailures: 5, globalFailures: 50, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

const GLOBAL = "*";

/**
 * Failed-login budget per IP and across all IPs. A spent budget locks for lockMs; the global
 * lock caps a distributed guessing run that rotates addresses.
 */
export class LoginGuard {
  private readonly failures: WindowCounter;
  private readonly lockedUntil = new Map<string, number>();

  constructor(private readonly opts: LoginGuardOptions = LOGIN_GUARD_DEFAULTS) {
    this.failures = new WindowCounter(Number.MAX_SAFE_INTEGER, opts.windowMs);
  }

  /**
   * Milliseconds until this IP may try again; 0 when it may try now. A trusted IP (one already
   * holding a live session) skips the global lock, so strangers spending the global budget
   * cannot shut the operator out.
   */
  lockedFor(ip: string, now = Date.now(), opts: { trusted?: boolean } = {}): number {
    const ipLock = this.remaining(ip, now);
    return opts.trusted ? ipLock : Math.max(ipLock, this.remaining(GLOBAL, now));
  }

  /** Records a failure; returns which lock it tripped, if any. */
  recordFailure(ip: string, now = Date.now()): "ip" | "global" | null {
    this.failures.hit(ip, now);
    this.failures.hit(GLOBAL, now);
    if (this.failures.count(GLOBAL, now) >= this.opts.globalFailures && this.remaining(GLOBAL, now) === 0) {
      this.lockedUntil.set(GLOBAL, now + this.opts.lockMs);
      return "global";
    }
    if (this.failures.count(ip, now) >= this.opts.perIpFailures && this.remaining(ip, now) === 0) {
      this.lockedUntil.set(ip, now + this.opts.lockMs);
      return "ip";
    }
    return null;
  }

  recordSuccess(ip: string): void {
    this.failures.reset(ip);
  }

  sweep(now = Date.now()): void {
    this.failures.sweep(now);
    for (const [key, until] of this.lockedUntil) if (until <= now) this.lockedUntil.delete(key);
  }

  private remaining(key: string, now: number): number {
    const until = this.lockedUntil.get(key);
    return until && until > now ? until - now : 0;
  }
}

/** A counting semaphore that refuses instead of queueing, so a flood cannot pile up work. */
export class Concurrency {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}
