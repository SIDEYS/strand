/**
 * Timestamp source for presence ops. Phase 2 stamped with a bare
 * Date.now(); once several instances stamp independently, their wall clocks
 * disagree by some amount, and LWW would let an instance running behind
 * lose to its own earlier writes made on another instance (a reconnecting
 * client's first update on the new instance stamped *before* the removal
 * the old instance published for it).
 *
 * This is a minimal hybrid logical clock: stamps are wall time, but never
 * less than 1 past anything this instance has already stamped or observed.
 * So once instance B has seen A's op, anything B stamps afterwards sorts
 * after it regardless of skew. It does not fix skew between instances that
 * never observe each other; that case is bounded by presence being
 * self-healing (see ADR 0002).
 */
export class HybridClock {
  #wall: () => number;
  #maxDriftMs: number;
  #last = 0;

  /** maxDriftMs caps how far ahead of our own wall clock an observed
   * timestamp may drag us. Without it one instance with a wildly wrong
   * clock would push every other instance's stamps into the far future
   * (and, via observe(), keep them there). Instances are trusted, so this
   * guards against misconfiguration, not an attacker. */
  constructor(wall: () => number = Date.now, maxDriftMs = 60_000) {
    this.#wall = wall;
    this.#maxDriftMs = maxDriftMs;
  }

  now(): number {
    const t = Math.max(this.#wall(), this.#last + 1);
    this.#last = t;
    return t;
  }

  /** Returns false if the timestamp was ignored for being too far ahead. */
  observe(timestamp: number): boolean {
    if (timestamp > this.#wall() + this.#maxDriftMs) return false;
    if (timestamp > this.#last) this.#last = timestamp;
    return true;
  }
}
