// Tiny fixed-window rate limiter for local API abuse / accidental loops.
export class RateLimiter {
  constructor({ limit = 120, windowMs = 60000, now = () => Date.now() } = {}) {
    this.limit = Math.max(1, limit);
    this.windowMs = Math.max(1000, windowMs);
    this.now = now;
    this.buckets = new Map();
  }

  check(key = "default") {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      return {
        ok: false,
        limit: this.limit,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((bucket.start + this.windowMs - now) / 1000)),
      };
    }
    return { ok: true, limit: this.limit, remaining: Math.max(0, this.limit - bucket.count), retryAfter: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }
}
