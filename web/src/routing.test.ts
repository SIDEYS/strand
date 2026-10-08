import { describe, expect, it } from 'vitest';
import {
  initials,
  parseRoute,
  randomRoomId,
  roomPath,
  roomSlug,
  scrollFraction,
  scrollTopForFraction,
} from './routing.js';

describe('roomSlug', () => {
  it('lowercases and replaces anything outside a safe alphabet', () => {
    expect(roomSlug('  My Team / Notes!  ')).toBe('my-team-notes');
    expect(roomSlug('Ünïcode rôom')).toBe('n-code-r-om');
  });

  it('cannot produce a path separator, a dot, or anything that needs escaping', () => {
    for (const hostile of ['../../etc/passwd', 'a/b', 'a\\b', '<script>', 'x y%00z', '.hidden']) {
      expect(roomSlug(hostile)).toMatch(/^[a-z0-9_-]*$/);
    }
  });

  it('bounds the length and never ends on a dangling separator', () => {
    const slug = roomSlug('a'.repeat(200));
    expect(slug.length).toBe(64);
    expect(roomSlug('word-'.repeat(30)).endsWith('-')).toBe(false);
  });

  it('is empty for input with nothing usable in it', () => {
    expect(roomSlug('!!!')).toBe('');
  });
});

describe('parseRoute', () => {
  it('opens the picker at the root and for unknown paths', () => {
    expect(parseRoute('/')).toEqual({ page: 'picker' });
    expect(parseRoute('/something/else')).toEqual({ page: 'picker' });
  });

  it('opens a room at /r/<room>, with or without a trailing slash', () => {
    expect(parseRoute('/r/demo')).toEqual({ page: 'room', roomId: 'demo' });
    expect(parseRoute('/r/demo/')).toEqual({ page: 'room', roomId: 'demo' });
  });

  it('normalises the room ID so two spellings of one room share a document', () => {
    expect(parseRoute('/r/My%20Room')).toEqual({ page: 'room', roomId: 'my-room' });
  });

  it('falls back to the picker for a room with nothing usable in it, or bad encoding', () => {
    expect(parseRoute('/r/!!!')).toEqual({ page: 'picker' });
    expect(parseRoute('/r/%E0%A4%A')).toEqual({ page: 'picker' });
  });

  it('round-trips with roomPath', () => {
    expect(parseRoute(roomPath('demo'))).toEqual({ page: 'room', roomId: 'demo' });
  });
});

describe('generated names', () => {
  it('makes a readable, valid, deterministic room id from the injected randomness', () => {
    const id = randomRoomId(() => 0);
    expect(id).toBe('quick-otter-0000');
    expect(roomSlug(id)).toBe(id);
  });

  it('makes initials from one or several words', () => {
    expect(initials('Quick Otter')).toBe('QO');
    expect(initials('  ada ')).toBe('A');
    expect(initials('')).toBe('?');
  });
});

describe('scroll sync maths', () => {
  it('maps a scrolled position to a 0..1 fraction and back', () => {
    expect(scrollFraction(0, 1000, 400)).toBe(0);
    expect(scrollFraction(600, 1000, 400)).toBe(1);
    expect(scrollFraction(300, 1000, 400)).toBeCloseTo(0.5);
    expect(scrollTopForFraction(0.5, 2000, 500)).toBe(750);
  });

  it('copes with content that does not scroll, and with out-of-range input', () => {
    expect(scrollFraction(50, 300, 400)).toBe(0);
    expect(scrollTopForFraction(0.7, 300, 400)).toBe(0);
    expect(scrollFraction(9999, 1000, 400)).toBe(1);
    expect(scrollTopForFraction(5, 1000, 400)).toBe(600);
  });
});
