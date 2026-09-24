import { describe, expect, it } from 'vitest';
import { LwwSet } from './LwwSet.js';

/**
 * Deterministic PRNG (mulberry32) instead of Math.random(), so a failure
 * is reproducible from the seed printed in the failure message rather than
 * being a one-off flake nobody can reconstruct.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface RandomOp {
  kind: 'add' | 'remove';
  elementId: string;
  timestamp: number;
  writerId: string;
  value: { n: number };
}

/** Ops are drawn from a small element/writer/timestamp space on purpose —
 * that's what forces exact-timestamp and same-writer collisions, which is
 * where an LWW implementation actually tends to break. A wide-open random
 * space would mostly generate ops that never contend with each other. */
function generateOps(count: number, rng: () => number): RandomOp[] {
  const elementIds = ['e0', 'e1', 'e2'];
  const writerIds = ['w0', 'w1', 'w2', 'w3'];
  const timestamps = Array.from({ length: 8 }, (_, i) => i * 10);
  const ops: RandomOp[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({
      kind: rng() < 0.35 ? 'remove' : 'add',
      elementId: elementIds[Math.floor(rng() * elementIds.length)]!,
      timestamp: timestamps[Math.floor(rng() * timestamps.length)]!,
      writerId: writerIds[Math.floor(rng() * writerIds.length)]!,
      value: { n: Math.floor(rng() * 1000) },
    });
  }
  return ops;
}

function applyOps(set: LwwSet<{ n: number }>, ops: RandomOp[]): void {
  for (const op of ops) {
    if (op.kind === 'add') {
      set.add(op.elementId, op.value, op.timestamp, op.writerId);
    } else {
      set.remove(op.elementId, op.timestamp, op.writerId);
    }
  }
}

const SEED = 20260924;
const OP_COUNT = 300;
const REPLICA_COUNT = 4;

describe('LwwSet convergence under random operations and arrival orders', () => {
  it('all replicas converge to the same state regardless of the order they apply the same ops in', () => {
    const rng = mulberry32(SEED);
    const ops = generateOps(OP_COUNT, rng);

    const replicas = Array.from({ length: REPLICA_COUNT }, () => new LwwSet<{ n: number }>());
    for (const replica of replicas) {
      applyOps(replica, shuffled(ops, rng));
    }

    for (let i = 1; i < replicas.length; i++) {
      expect(
        replicas[i]!.equals(replicas[0]!),
        `replica ${i} diverged from replica 0 (seed=${SEED}, ops=${OP_COUNT})`,
      ).toBe(true);
    }
  });

  it('all replicas converge to the same state regardless of merge order, when ops are authored across replicas', () => {
    const rng = mulberry32(SEED + 1);
    const ops = generateOps(OP_COUNT, rng);

    // Partition ops round-robin across REPLICA_COUNT "home" replicas, as if
    // each replica locally authored a quarter of the history, then build
    // each home replica's partial set by applying its own slice in a
    // locally-shuffled order.
    const partials = Array.from({ length: REPLICA_COUNT }, () => new LwwSet<{ n: number }>());
    const perReplicaOps: RandomOp[][] = Array.from({ length: REPLICA_COUNT }, () => []);
    ops.forEach((op, i) => perReplicaOps[i % REPLICA_COUNT]!.push(op));
    perReplicaOps.forEach((replicaOps, i) => applyOps(partials[i]!, shuffled(replicaOps, rng)));

    // Each of REPLICA_COUNT "gossip targets" merges all partials together,
    // each in its own random fold order.
    const merged = Array.from({ length: REPLICA_COUNT }, () => {
      const target = new LwwSet<{ n: number }>();
      for (const partial of shuffled(partials, rng)) {
        target.merge(partial);
      }
      return target;
    });

    for (let i = 1; i < merged.length; i++) {
      expect(
        merged[i]!.equals(merged[0]!),
        `merge order ${i} diverged from merge order 0 (seed=${SEED + 1}, ops=${OP_COUNT})`,
      ).toBe(true);
    }
  });
});
