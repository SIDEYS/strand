import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEMO_MARKDOWN, demoSeedUpdate } from './seed.js';

const textOf = (doc: Y.Doc) => doc.getText('content').toJSON();

describe('demo seed', () => {
  it('produces identical bytes every time, which is what makes it safe to apply anywhere', () => {
    const rebuilt = new Y.Doc();
    rebuilt.clientID = 0x5eed0001;
    rebuilt.getText('content').insert(0, DEMO_MARKDOWN);
    expect(Array.from(demoSeedUpdate())).toEqual(Array.from(Y.encodeStateAsUpdate(rebuilt)));
  });

  it('puts the intended content in an empty document', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, demoSeedUpdate());
    expect(textOf(doc)).toBe(DEMO_MARKDOWN);
  });

  it('is idempotent: applying it repeatedly never duplicates the text', () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 5; i++) Y.applyUpdate(doc, demoSeedUpdate());
    expect(textOf(doc)).toBe(DEMO_MARKDOWN);
  });

  it('does not duplicate when two instances seed independently and then merge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, demoSeedUpdate());
    Y.applyUpdate(b, demoSeedUpdate());
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(textOf(a)).toBe(DEMO_MARKDOWN);
    expect(textOf(b)).toBe(DEMO_MARKDOWN);
  });

  it('never resurrects text a user deleted, even when the seed is applied again later', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, demoSeedUpdate());
    doc.getText('content').delete(0, doc.getText('content').length);
    doc.getText('content').insert(0, 'my own document');

    // A different instance creating the room afterwards applies the seed to
    // the state it received from a peer.
    const late = new Y.Doc();
    Y.applyUpdate(late, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(late, demoSeedUpdate());
    expect(textOf(late)).toBe('my own document');
  });

  it('keeps edits that build on seed text valid when the seed arrives later than the edit', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, demoSeedUpdate());
    doc.getText('content').insert(0, 'PREFIX ');
    const edited = Y.encodeStateAsUpdate(doc);

    const other = new Y.Doc();
    Y.applyUpdate(other, edited);
    expect(textOf(other)).toBe('PREFIX ' + DEMO_MARKDOWN);
  });

  it('says what to try', () => {
    expect(DEMO_MARKDOWN).toMatch(/second window/i);
    expect(DEMO_MARKDOWN).toMatch(/wifi/i);
    expect(DEMO_MARKDOWN).toMatch(/keep typing/i);
  });
});
