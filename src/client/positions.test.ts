import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodePosition, encodePosition, fromPresencePositions, toPresencePositions } from './positions.js';

function docWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, text);
  return { doc, ytext };
}

/** Where a remote cursor, shipped as bytes, lands in a given copy of the doc. */
function resolve(bytes: Uint8Array, doc: Y.Doc): number | null {
  return Y.createAbsolutePositionFromRelativePosition(decodePosition(bytes), doc)?.index ?? null;
}

describe('relative cursor positions', () => {
  it('stays on the same character when someone inserts above it concurrently (an integer offset would not)', () => {
    const { doc: mine, ytext: myText } = docWith('hello world');
    // Another user's caret sits just before the "w": offset 6.
    const caret = encodePosition(Y.createRelativePositionFromTypeIndex(myText, 6));
    const naiveOffset = 6;

    // They are editing the same document; a third party inserts at the top.
    myText.insert(0, 'BIG NEW HEADING\n');

    const landed = resolve(caret, mine)!;
    expect(mine.getText('content').toJSON()[landed]).toBe('w'); // still on its character
    expect(landed).toBe(6 + 'BIG NEW HEADING\n'.length);
    expect(naiveOffset).not.toBe(landed); // the offset would now point into the heading
  });

  it('resolves correctly in a different replica that applied the same edits in a different order', () => {
    const origin = docWith('abcdef');
    const caret = encodePosition(Y.createRelativePositionFromTypeIndex(origin.ytext, 3)); // before "d"

    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(origin.doc));
    // Two concurrent edits above the caret, applied to the replica.
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(origin.doc));
    editor.getText('content').insert(0, 'XX');
    editor.getText('content').insert(1, 'YY');
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(editor));

    const index = resolve(caret, replica)!;
    expect(replica.getText('content').toJSON()[index]).toBe('d');
  });

  it('follows its character through a deletion elsewhere', () => {
    const { doc, ytext } = docWith('0123456789');
    const caret = encodePosition(Y.createRelativePositionFromTypeIndex(ytext, 7));
    ytext.delete(0, 3);
    expect(doc.getText('content').toJSON()[resolve(caret, doc)!]).toBe('7');
  });

  it('round-trips through the bytes that travel in a presence payload', () => {
    // Compared by where each resolves, not by Y.compareRelativePositions:
    // the encoding drops the type name when an item identifies it, so the
    // decoded form differs structurally while meaning exactly the same place.
    const { doc, ytext } = docWith('some text');
    const original = Y.createRelativePositionFromTypeIndex(ytext, 4);
    const decoded = decodePosition(encodePosition(original));
    expect(Y.createAbsolutePositionFromRelativePosition(decoded, doc)!.index).toBe(4);
    expect(Y.createAbsolutePositionFromRelativePosition(original, doc)!.index).toBe(4);
  });

  it('is small enough to send on every cursor move', () => {
    const { ytext } = docWith('x'.repeat(10_000));
    expect(encodePosition(Y.createRelativePositionFromTypeIndex(ytext, 5000)).length).toBeLessThan(32);
  });
});

describe('presence cursor encoding', () => {
  const { doc, ytext } = docWith('select some of this');
  const at = (i: number) => Y.createRelativePositionFromTypeIndex(ytext, i);
  const indexOf = (position: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(position, doc)!.index;

  it('carries a plain caret as just a cursor, with no selection', () => {
    const value = toPresencePositions({ anchor: at(3), head: at(3) });
    expect(value.cursor).not.toBeNull();
    expect(value.selection).toBeNull();
  });

  it('carries a real selection as anchor and head', () => {
    const value = toPresencePositions({ anchor: at(2), head: at(8) });
    expect(value.cursor).not.toBeNull();
    expect(value.selection).not.toBeNull();
  });

  it('round-trips both shapes, preserving anchor and head separately', () => {
    const selection = fromPresencePositions(toPresencePositions({ anchor: at(2), head: at(8) }))!;
    expect([indexOf(selection.anchor), indexOf(selection.head)]).toEqual([2, 8]);

    const caret = fromPresencePositions(toPresencePositions({ anchor: at(5), head: at(5) }))!;
    expect([indexOf(caret.anchor), indexOf(caret.head)]).toEqual([5, 5]);
  });

  it('represents no focus as no cursor at all', () => {
    expect(toPresencePositions(null)).toEqual({ cursor: null, selection: null });
    expect(fromPresencePositions({ cursor: null, selection: null })).toBeNull();
  });

  it('accepts the plain-JSON form a position takes after being copied through state', () => {
    const json = JSON.parse(JSON.stringify(at(4))) as Y.RelativePosition;
    const value = toPresencePositions({ anchor: json, head: json });
    expect(indexOf(decodePosition(value.cursor!))).toBe(4);
  });
});
