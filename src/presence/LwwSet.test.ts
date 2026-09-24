import { describe, expect, it } from 'vitest';
import { LwwSet } from './LwwSet.js';

interface TestValue {
  n: number;
}

function replicaWithAdds(entries: Array<[elementId: string, value: TestValue, timestamp: number, writerId: string]>) {
  const set = new LwwSet<TestValue>();
  for (const [elementId, value, timestamp, writerId] of entries) {
    set.add(elementId, value, timestamp, writerId);
  }
  return set;
}

describe('LwwSet convergence laws', () => {
  it('merge is commutative: A merged with B equals B merged with A', () => {
    const a = replicaWithAdds([
      ['alice', { n: 1 }, 10, 'alice'],
      ['bob', { n: 2 }, 5, 'bob'],
    ]);
    const b = replicaWithAdds([
      ['alice', { n: 99 }, 20, 'alice'],
      ['carol', { n: 3 }, 7, 'carol'],
    ]);
    b.remove('bob', 15, 'bob');

    expect(a.merged(b).equals(b.merged(a))).toBe(true);
  });

  it('merge is associative: (A merged B) merged C equals A merged (B merged C)', () => {
    const a = replicaWithAdds([['x', { n: 1 }, 1, 'a']]);
    const b = replicaWithAdds([['x', { n: 2 }, 2, 'b']]);
    const c = replicaWithAdds([['x', { n: 3 }, 2, 'c']]);
    b.remove('y', 5, 'b');
    c.add('y', { n: 4 }, 8, 'c');

    const left = a.merged(b).merged(c);
    const right = a.merged(b.merged(c));
    expect(left.equals(right)).toBe(true);
  });

  it('merge is idempotent: A merged with itself equals A', () => {
    const a = replicaWithAdds([
      ['alice', { n: 1 }, 10, 'alice'],
      ['bob', { n: 2 }, 5, 'bob'],
    ]);
    a.remove('bob', 6, 'bob');

    expect(a.merged(a).equals(a)).toBe(true);
  });
});

describe('LwwSet tie-breaking', () => {
  it('resolves two concurrent adds at the same timestamp by higher writerId, regardless of application order', () => {
    const forward = new LwwSet<TestValue>();
    forward.add('alice', { n: 1 }, 100, 'client-a');
    forward.add('alice', { n: 2 }, 100, 'client-z');

    const backward = new LwwSet<TestValue>();
    backward.add('alice', { n: 2 }, 100, 'client-z');
    backward.add('alice', { n: 1 }, 100, 'client-a');

    // 'client-z' > 'client-a' lexicographically, so it should win both ways.
    expect(forward.get('alice')).toEqual({ n: 2 });
    expect(backward.get('alice')).toEqual({ n: 2 });
  });

  it('treats equal timestamp and equal writerId as a dedupe, not a conflict', () => {
    const set = new LwwSet<TestValue>();
    set.add('alice', { n: 1 }, 100, 'client-a');
    set.add('alice', { n: 1 }, 100, 'client-a');
    expect(set.entries()).toHaveLength(1);
    expect(set.get('alice')).toEqual({ n: 1 });
  });

  it('add/remove tie at the same timestamp: remove wins', () => {
    const set = new LwwSet<TestValue>();
    set.add('alice', { n: 1 }, 100, 'alice');
    set.remove('alice', 100, 'alice');
    expect(set.has('alice')).toBe(false);
  });

  it('a later add reinstates a previously removed element', () => {
    const set = new LwwSet<TestValue>();
    set.remove('alice', 100, 'alice');
    set.add('alice', { n: 1 }, 200, 'alice');
    expect(set.has('alice')).toBe(true);
  });

  it('a stale add applied after the fact does not resurrect a removed element', () => {
    const set = new LwwSet<TestValue>();
    set.remove('alice', 200, 'alice');
    // This add is chronologically earlier but arrives (is applied) later —
    // exactly the out-of-order delivery LWW is supposed to survive.
    set.add('alice', { n: 1 }, 100, 'alice');
    expect(set.has('alice')).toBe(false);
  });
});

describe('LwwSet tombstone bounding', () => {
  it('keeps a tombstone until it is older than the ttl, then prunes it', () => {
    const set = new LwwSet<TestValue>(1000);
    set.add('alice', { n: 1 }, 0, 'alice');
    set.remove('alice', 0, 'alice');

    set.pruneTombstones(500);
    expect(set.has('alice')).toBe(false); // still absent (that's independent of pruning)

    set.pruneTombstones(1500);
    // After pruning, re-adding an *old* timestamped value would no longer
    // be beaten by the (now-forgotten) remove — this is the documented
    // tradeoff, exercised explicitly below.
    set.add('alice', { n: 2 }, 100, 'alice');
    expect(set.has('alice')).toBe(true);
  });

  it('never prunes a currently-present element, regardless of age', () => {
    const set = new LwwSet<TestValue>(1000);
    set.add('alice', { n: 1 }, 0, 'alice');
    set.pruneTombstones(1_000_000);
    expect(set.has('alice')).toBe(true);
  });

  it('documents the bounded-tombstone tradeoff: a sufficiently late add resurrects a removed element', () => {
    const set = new LwwSet<TestValue>(1000);
    set.add('alice', { n: 1 }, 0, 'alice');
    set.remove('alice', 10, 'alice');
    expect(set.has('alice')).toBe(false);

    // Tombstone ages past its bound and gets pruned...
    set.pruneTombstones(10 + 1000 + 1);
    // ...so a very late add from before the removal now wins, because
    // nothing remembers the removal happened. Acceptable because this
    // requires delivery delayed well beyond any realistic reconciliation
    // window (Phase 3) — but it is a real, permanent tradeoff, not a bug.
    set.add('alice', { n: 1 }, 5, 'alice');
    expect(set.has('alice')).toBe(true);
  });
});
