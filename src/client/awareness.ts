import type { PresenceValue } from '../presence/types.js';
import { fromPresencePositions, toPresencePositions, type CursorState } from './positions.js';

/** What the adapter needs from the client. CollabClient satisfies it; tests
 * pass a hand-rolled one. */
export interface PresenceSource {
  getSnapshot(): { clientId: string; peers: readonly { clientId: string; value: PresenceValue }[] };
  subscribe(listener: () => void): () => void;
  setPresence(value: PresenceValue): void;
}

export interface LocalUser {
  name: string;
  color: string;
}

interface AwarenessState {
  user: { name: string; color: string };
  cursor: CursorState | null;
}

export interface AwarenessChange {
  added: string[];
  updated: string[];
  removed: string[];
}

type ChangeListener = (change: AwarenessChange, origin: unknown) => void;

/**
 * Lets y-codemirror.next draw remote cursors from our presence set.
 *
 * The editor binding takes an object shaped like y-protocols' Awareness. We
 * do not use that library or its protocol: presence in this system is an
 * LWW-element-set, stamped by the server, carried by our own messages. This
 * is only the narrow interface the binding calls (`doc.clientID`,
 * `getStates`, `getLocalState`, `setLocalStateField`, `on`/`off('change')`),
 * backed by that set.
 *
 * Cursors are Yjs relative positions end to end. The binding hands us
 * RelativePosition objects, which we encode into the presence payload, and
 * decodes the ones we give back against its own copy of the document, so a
 * remote cursor stays on the same character however the text around it is
 * edited in the meantime.
 */
export class PresenceAwareness {
  #source: PresenceSource;
  #user: LocalUser;
  #cursor: CursorState | null = null;
  #remote = new Map<string, { fingerprint: string; state: AwarenessState }>();
  #localKey: string;
  #listeners = new Set<ChangeListener>();
  #unsubscribe: () => void;

  constructor(source: PresenceSource, user: LocalUser) {
    this.#source = source;
    this.#user = user;
    this.#localKey = source.getSnapshot().clientId || 'local';
    this.#unsubscribe = source.subscribe(() => this.#refresh());
    this.#refresh();
    // Be visible straight away, before any caret exists.
    this.#publish();
  }

  /** The binding compares each state's key with `doc.clientID` to skip its
   * own. The key is our server-assigned client ID, which only exists after
   * the handshake, so this is read fresh each time. */
  get doc(): { clientID: string } {
    return { clientID: this.#localKey };
  }

  getLocalState(): AwarenessState {
    return { user: this.#user, cursor: this.#cursor };
  }

  getStates(): Map<string, AwarenessState> {
    const states = new Map<string, AwarenessState>();
    states.set(this.#localKey, this.getLocalState());
    for (const [key, { state }] of this.#remote) states.set(key, state);
    return states;
  }

  setLocalStateField(field: string, value: unknown): void {
    if (field === 'cursor') {
      this.#cursor = value === null || value === undefined ? null : (value as CursorState);
      this.#publish();
      this.#emit({ added: [], updated: [this.#localKey], removed: [] });
    }
  }

  setUser(user: LocalUser): void {
    this.#user = user;
    this.#publish();
  }

  on(event: 'change' | 'update', listener: ChangeListener): void {
    if (event === 'change') this.#listeners.add(listener);
  }

  off(event: 'change' | 'update', listener: ChangeListener): void {
    if (event === 'change') this.#listeners.delete(listener);
  }

  destroy(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #publish(): void {
    this.#source.setPresence({
      displayName: this.#user.name,
      color: this.#user.color,
      ...toPresencePositions(this.#cursor),
    });
  }

  #refresh(): void {
    const snapshot = this.#source.getSnapshot();
    const change: AwarenessChange = { added: [], updated: [], removed: [] };

    const nextLocalKey = snapshot.clientId || 'local';
    if (nextLocalKey !== this.#localKey) {
      this.#localKey = nextLocalKey;
      change.updated.push(nextLocalKey);
    }

    const next = new Map<string, { fingerprint: string; state: AwarenessState }>();
    for (const peer of snapshot.peers) {
      const fingerprint = JSON.stringify([
        peer.value.displayName,
        peer.value.color,
        peer.value.cursor && Array.from(peer.value.cursor),
        peer.value.selection && [Array.from(peer.value.selection.anchor), Array.from(peer.value.selection.head)],
      ]);
      const before = this.#remote.get(peer.clientId);
      if (before === undefined) change.added.push(peer.clientId);
      else if (before.fingerprint !== fingerprint) change.updated.push(peer.clientId);
      next.set(peer.clientId, {
        fingerprint,
        state:
          before !== undefined && before.fingerprint === fingerprint
            ? before.state
            : {
                user: { name: peer.value.displayName, color: peer.value.color },
                cursor: fromPresencePositions(peer.value),
              },
      });
    }
    for (const key of this.#remote.keys()) if (!next.has(key)) change.removed.push(key);
    this.#remote = next;

    if (change.added.length || change.updated.length || change.removed.length) this.#emit(change);
  }

  #emit(change: AwarenessChange): void {
    for (const listener of [...this.#listeners]) listener(change, 'local');
  }
}
