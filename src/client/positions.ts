import * as Y from 'yjs';
import type { EncodedPosition, PresenceValue } from '../presence/types.js';

/** A caret or selection as Yjs relative positions. */
export interface CursorState {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

/** Accepts the plain-JSON form too, which is what a position looks like after
 * being copied through an awareness-style state object. */
function normalise(position: Y.RelativePosition): Y.RelativePosition {
  return Y.createRelativePositionFromJSON(position);
}

export function encodePosition(position: Y.RelativePosition): EncodedPosition {
  return Y.encodeRelativePosition(normalise(position));
}

export function decodePosition(bytes: EncodedPosition): Y.RelativePosition {
  return Y.decodeRelativePosition(bytes);
}

/** The cursor/selection halves of a presence value for a local cursor. A
 * plain caret has anchor equal to head and carries no selection. */
export function toPresencePositions(cursor: CursorState | null): Pick<PresenceValue, 'cursor' | 'selection'> {
  if (cursor === null) return { cursor: null, selection: null };
  const anchor = normalise(cursor.anchor);
  const head = normalise(cursor.head);
  return {
    cursor: encodePosition(head),
    selection: Y.compareRelativePositions(anchor, head) ? null : { anchor: encodePosition(anchor), head: encodePosition(head) },
  };
}

/** Inverse of toPresencePositions. */
export function fromPresencePositions(value: Pick<PresenceValue, 'cursor' | 'selection'>): CursorState | null {
  if (value.selection) {
    return { anchor: decodePosition(value.selection.anchor), head: decodePosition(value.selection.head) };
  }
  if (value.cursor) {
    const position = decodePosition(value.cursor);
    return { anchor: position, head: position };
  }
  return null;
}
