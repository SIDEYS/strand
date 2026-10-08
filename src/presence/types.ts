/**
 * An encoded Yjs `RelativePosition` (see `Y.encodeRelativePosition`).
 *
 * Opaque to the server and to the LWW set: they only carry the bytes. It is a
 * relative position and not a character offset because an offset into a
 * document someone else is editing concurrently is wrong the moment they
 * insert above it. A relative position is anchored to a character's identity,
 * so a remote cursor stays on the same character however the text around it
 * changes, and each client resolves it against its own copy of the document.
 */
export type EncodedPosition = Uint8Array;

export interface PresenceSelection {
  anchor: EncodedPosition;
  head: EncodedPosition;
}

/** What a presence entry carries. Owned by the presence module (not the
 * protocol module) because the wire encoding is a detail of how this value
 * travels, not what it means. */
export interface PresenceValue {
  displayName: string;
  color: string;
  /** Where the caret is (the selection's head), or null if the client has no
   * focus in the editor. */
  cursor: EncodedPosition | null;
  /** Set only while text is actually selected (anchor differs from head). */
  selection: PresenceSelection | null;
}
