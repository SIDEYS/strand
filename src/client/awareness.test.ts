import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PresenceValue } from '../presence/types.js';
import { PresenceAwareness, type AwarenessChange, type PresenceSource } from './awareness.js';
import { encodePosition } from './positions.js';

/** A hand-driven stand-in for the client: tests move `peers` and call `fire`. */
class FakeSource implements PresenceSource {
  clientId = '';
  peers: Array<{ clientId: string; value: PresenceValue }> = [];
  published: PresenceValue[] = [];
  #listeners = new Set<() => void>();
  #snapshot = { clientId: '', peers: [] as FakeSource['peers'] };

  getSnapshot() {
    return this.#snapshot;
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  setPresence(value: PresenceValue) {
    this.published.push(value);
  }
  get listenerCount() {
    return this.#listeners.size;
  }
  fire() {
    this.#snapshot = { clientId: this.clientId, peers: [...this.peers] };
    for (const listener of [...this.#listeners]) listener();
  }
}

const user = { name: 'Ada', color: '#ff00ff' };
const rel = (ytext: Y.Text, i: number) => Y.createRelativePositionFromTypeIndex(ytext, i);

function textDoc(text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, text);
  return { doc, ytext };
}

describe('PresenceAwareness', () => {
  it('announces the user straight away, before any caret exists', () => {
    const source = new FakeSource();
    new PresenceAwareness(source, user);
    expect(source.published).toEqual([{ displayName: 'Ada', color: '#ff00ff', cursor: null, selection: null }]);
  });

  it('publishes a caret as an encoded relative position, and a selection with both ends', () => {
    const source = new FakeSource();
    const awareness = new PresenceAwareness(source, user);
    const { ytext } = textDoc('hello world');

    awareness.setLocalStateField('cursor', { anchor: rel(ytext, 3), head: rel(ytext, 3) });
    const caret = source.published.at(-1)!;
    expect(caret.cursor).toEqual(encodePosition(rel(ytext, 3)));
    expect(caret.selection).toBeNull();

    awareness.setLocalStateField('cursor', { anchor: rel(ytext, 2), head: rel(ytext, 8) });
    const selected = source.published.at(-1)!;
    expect(selected.selection).toEqual({ anchor: encodePosition(rel(ytext, 2)), head: encodePosition(rel(ytext, 8)) });

    awareness.setLocalStateField('cursor', null);
    expect(source.published.at(-1)).toMatchObject({ cursor: null, selection: null });
  });

  it('exposes peers in the shape the editor binding reads, with positions that resolve against the doc', () => {
    const source = new FakeSource();
    const awareness = new PresenceAwareness(source, user);
    const { doc, ytext } = textDoc('hello world');

    source.peers = [
      {
        clientId: 'peer-1',
        value: { displayName: 'Grace', color: '#00aa00', cursor: encodePosition(rel(ytext, 6)), selection: null },
      },
    ];
    source.fire();

    const state = awareness.getStates().get('peer-1')!;
    expect(state.user).toEqual({ name: 'Grace', color: '#00aa00' });
    // Exactly the call the binding makes with it:
    const head = Y.createAbsolutePositionFromRelativePosition(state.cursor!.head, doc)!;
    expect(head.index).toBe(6);

    // And it stays on its character when text is inserted above.
    ytext.insert(0, 'XXX');
    expect(Y.createAbsolutePositionFromRelativePosition(state.cursor!.head, doc)!.index).toBe(9);
  });

  it('keys the local state by doc.clientID, which follows the server-assigned ID once known', () => {
    const source = new FakeSource();
    const awareness = new PresenceAwareness(source, user);
    expect(awareness.getStates().has(awareness.doc.clientID)).toBe(true);

    source.clientId = 'server-assigned';
    source.fire();
    expect(awareness.doc.clientID).toBe('server-assigned');
    expect(awareness.getStates().has('server-assigned')).toBe(true);
    expect(awareness.getStates().has('local')).toBe(false);
  });

  it('reports added, updated, and removed peers as change events, and nothing when nothing changed', () => {
    const source = new FakeSource();
    const awareness = new PresenceAwareness(source, user);
    const changes: AwarenessChange[] = [];
    awareness.on('change', (change) => changes.push(change));
    const peer = (name: string): PresenceValue => ({ displayName: name, color: '#123', cursor: null, selection: null });

    source.peers = [{ clientId: 'p', value: peer('one') }];
    source.fire();
    source.peers = [{ clientId: 'p', value: peer('two') }];
    source.fire();
    source.fire(); // same state again
    source.peers = [];
    source.fire();

    expect(changes).toEqual([
      { added: ['p'], updated: [], removed: [] },
      { added: [], updated: ['p'], removed: [] },
      { added: [], updated: [], removed: ['p'] },
    ]);
  });

  it('stops listening after destroy, and after off', () => {
    const source = new FakeSource();
    const awareness = new PresenceAwareness(source, user);
    const seen: AwarenessChange[] = [];
    const listener = (change: AwarenessChange) => seen.push(change);
    awareness.on('change', listener);
    awareness.off('change', listener);
    source.peers = [{ clientId: 'p', value: { displayName: 'x', color: '#1', cursor: null, selection: null } }];
    source.fire();
    expect(seen).toEqual([]);

    expect(source.listenerCount).toBe(1);
    awareness.destroy();
    expect(source.listenerCount).toBe(0);
  });
});
