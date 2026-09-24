/**
 * A last-write-wins element set, keyed by element ID, where each element
 * also carries a value (not just membership) — closer to an "LWW map with
 * tombstones" than the textbook two-G-Set LWW-element-set, but it obeys the
 * same convergence laws and is what the presence use case actually needs:
 * for a given clientId, the room wants to know both "are they here" and
 * "what's their cursor doing right now."
 *
 * No I/O: every timestamp is supplied by the caller. See
 * docs/adr/0001-presence-lww-set.md for why the server stamps these on
 * receipt rather than trusting a client-supplied clock.
 */
interface Op {
  timestamp: number;
  writerId: string;
}

/**
 * Total order over two ops of the same kind (two adds, or two removes)
 * racing for the same element: later timestamp wins; equal timestamp falls
 * back to a lexicographic compare on writerId (higher string wins) — a
 * plain total order, chosen only for determinism, not for any meaning
 * attached to "higher."
 */
function compareBase(a: Op, b: Op): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  return 0;
}

interface AddRecord<V> extends Op {
  value: V;
}

/**
 * Same as compareBase, but for adds specifically: equal timestamp AND
 * equal writerId means the same client's write arrived twice (retransmit /
 * redundant delivery), which should be a no-op dedupe rather than a
 * conflict — that holds as long as the two records are actually identical.
 * If they somehow aren't (a bug upstream, not a scenario this protocol
 * should produce), fall back to comparing the serialized value so the
 * comparator is still total and doesn't depend on merge order.
 */
function compareAddOps<V>(a: AddRecord<V>, b: AddRecord<V>): number {
  const base = compareBase(a, b);
  if (base !== 0) return base;
  const av = JSON.stringify(a.value);
  const bv = JSON.stringify(b.value);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

type RemoveRecord = Op;

interface ElementState<V> {
  add?: AddRecord<V>;
  remove?: RemoveRecord;
}

export interface PresentEntry<V> {
  elementId: string;
  value: V;
  timestamp: number;
  writerId: string;
}

/** How long a tombstone (a remove record for an element with no live add
 * beating it) is retained after its timestamp before pruneTombstones() will
 * drop it. Bounded so the set doesn't grow forever; the tradeoff is that an
 * add delayed longer than this window after the matching remove will
 * incorrectly resurrect the element, because by then nothing remembers the
 * removal happened. Set well above any realistic presence TTL (Phase 3) so
 * that window essentially never opens in practice — but it is not zero. */
export const DEFAULT_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

export class LwwSet<V> {
  #elements = new Map<string, ElementState<V>>();
  #tombstoneTtlMs: number;

  constructor(tombstoneTtlMs = DEFAULT_TOMBSTONE_TTL_MS) {
    this.#tombstoneTtlMs = tombstoneTtlMs;
  }

  /** Applies an add. writerId should be the actual origin of the write —
   * for presence, always the element's own owning clientId, since the
   * server never lets a client write another client's entry. */
  add(elementId: string, value: V, timestamp: number, writerId: string): void {
    const state = this.#elements.get(elementId) ?? {};
    const candidate: AddRecord<V> = { value, timestamp, writerId };
    if (!state.add || compareAddOps(candidate, state.add) > 0) {
      state.add = candidate;
    }
    this.#elements.set(elementId, state);
  }

  remove(elementId: string, timestamp: number, writerId: string): void {
    const state = this.#elements.get(elementId) ?? {};
    const candidate: RemoveRecord = { timestamp, writerId };
    if (!state.remove || compareBase(candidate, state.remove) > 0) {
      state.remove = candidate;
    }
    this.#elements.set(elementId, state);
  }

  /** True if elementId is currently present: it has an add record, and
   * that add isn't beaten by a remove. Remove wins ties (equal timestamp)
   * by design — see docs/adr/0001-presence-lww-set.md. A stale add
   * resurrecting a departed collaborator is worse than a collaborator
   * being briefly absent, since presence re-adds itself on the next
   * heartbeat regardless. */
  has(elementId: string): boolean {
    const state = this.#elements.get(elementId);
    if (!state?.add) return false;
    if (!state.remove) return true;
    return state.add.timestamp > state.remove.timestamp;
  }

  get(elementId: string): V | undefined {
    return this.has(elementId) ? this.#elements.get(elementId)!.add!.value : undefined;
  }

  /** All currently-present entries — what a newly-joined client should be
   * shown as the room's existing presence. */
  entries(): PresentEntry<V>[] {
    const out: PresentEntry<V>[] = [];
    for (const [elementId, state] of this.#elements) {
      if (this.has(elementId)) {
        const add = state.add!;
        out.push({ elementId, value: add.value, timestamp: add.timestamp, writerId: add.writerId });
      }
    }
    return out;
  }

  /**
   * Merges another LwwSet's state into this one in place. Per element, per
   * record kind (add / remove), keeps whichever of the two records wins
   * under the total order above. Because "keep the max under a total
   * order" is itself commutative, associative, and idempotent, so is this
   * merge — see LwwSet.test.ts for the laws asserted directly.
   */
  merge(other: LwwSet<V>): void {
    for (const [elementId, otherState] of other.#elements) {
      const state = this.#elements.get(elementId) ?? {};
      if (otherState.add && (!state.add || compareAddOps(otherState.add, state.add) > 0)) {
        state.add = otherState.add;
      }
      if (otherState.remove && (!state.remove || compareBase(otherState.remove, state.remove) > 0)) {
        state.remove = otherState.remove;
      }
      this.#elements.set(elementId, state);
    }
  }

  /** Returns a fresh LwwSet with the merge of `this` and `other`, leaving
   * both inputs untouched — convenient for the property tests, which merge
   * the same replicas in several different orders without one merge's
   * mutation contaminating the next. */
  merged(other: LwwSet<V>): LwwSet<V> {
    const result = new LwwSet<V>(this.#tombstoneTtlMs);
    result.merge(this);
    result.merge(other);
    return result;
  }

  /** Drops tombstones (elements with no live add, i.e. has() === false)
   * whose remove record is older than tombstoneTtlMs relative to `now`.
   * Caller-supplied `now` keeps this module free of wall-clock I/O; the
   * gateway is expected to call this periodically, not on every op. */
  pruneTombstones(now: number): void {
    for (const [elementId, state] of this.#elements) {
      if (this.has(elementId)) continue;
      const tombstoneAt = state.remove?.timestamp ?? state.add?.timestamp;
      if (tombstoneAt !== undefined && now - tombstoneAt > this.#tombstoneTtlMs) {
        this.#elements.delete(elementId);
      }
    }
  }

  /** Structural equality, used by the convergence tests to assert two
   * differently-merged replicas ended up identical. Compares only what's
   * observable (current membership + value), not internal tombstones — two
   * sets can differ in retained tombstone bookkeeping while still being
   * the same set from any external observer's point of view. */
  equals(other: LwwSet<V>): boolean {
    const a = this.entries();
    const b = other.entries();
    if (a.length !== b.length) return false;
    const bySortedId = (entries: PresentEntry<V>[]) =>
      [...entries].sort((x, y) => (x.elementId < y.elementId ? -1 : 1));
    const sa = bySortedId(a);
    const sb = bySortedId(b);
    return sa.every((entry, i) => JSON.stringify(entry.value) === JSON.stringify(sb[i]!.value));
  }
}
