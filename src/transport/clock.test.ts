import { describe, expect, it } from 'vitest';
import { HybridClock } from './clock.js';

describe('HybridClock', () => {
  it('stamps with wall time when the wall clock is moving forward', () => {
    let wall = 1000;
    const clock = new HybridClock(() => wall);
    expect(clock.now()).toBe(1000);
    wall = 1500;
    expect(clock.now()).toBe(1500);
  });

  it('never repeats or goes backwards when the wall clock stalls or steps back', () => {
    let wall = 1000;
    const clock = new HybridClock(() => wall);
    const a = clock.now();
    const b = clock.now(); // same wall reading
    wall = 900; // NTP step backwards
    const c = clock.now();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('stamps after an observed remote timestamp even if its own wall clock is behind', () => {
    const clock = new HybridClock(() => 1000);
    // Remote instance's clock runs 5s ahead of ours.
    expect(clock.observe(6000)).toBe(true);
    expect(clock.now()).toBeGreaterThan(6000);
  });

  it('ignores an observed timestamp further ahead than maxDriftMs', () => {
    const clock = new HybridClock(() => 1000, 10_000);
    expect(clock.observe(1000 + 10_001)).toBe(false);
    expect(clock.now()).toBe(1000);
  });

  it('is not moved backwards by observing an older timestamp', () => {
    const clock = new HybridClock(() => 5000);
    const first = clock.now();
    clock.observe(100);
    expect(clock.now()).toBeGreaterThan(first);
  });
});
