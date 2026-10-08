import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decode, encodeDocUpdate, encodeWelcome, MessageType } from '../../src/protocol/index.ts';
import {
  Typist,
  extractMarkers,
  frameDocUpdate,
  frameHello,
  framePong,
  framePresence,
  frameSyncStep1,
  marker,
  parseFrame,
  parseStateVector,
  varUint,
} from './frames.mjs';

const textOf = (doc) => doc.getText('content').toJSON();
const apply = (doc, update) => Y.applyUpdate(doc, update);

describe('hand-encoded Yjs updates', () => {
  it('apply to a real Yjs document and produce the typed text, in order', () => {
    const typist = new Typist(2_900_000_000); // past 2^31, like a real client ID
    const doc = new Y.Doc();
    for (const piece of ['hello ', 'brave ', 'new ', 'world']) apply(doc, typist.next(piece));
    expect(textOf(doc)).toBe('hello brave new world');
  });

  it('encode large client IDs and clocks as Yjs does', () => {
    const out = [];
    varUint(4_294_967_295, out);
    expect(out).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f]);
    const small = [];
    varUint(300, small);
    expect(small).toEqual([0xac, 0x02]);
  });

  it('converge when several users type concurrently, whatever order they arrive in', () => {
    const typists = [new Typist(111), new Typist(222), new Typist(333)];
    const updates = [];
    for (let round = 0; round < 6; round++) {
      for (const [i, typist] of typists.entries()) updates.push(typist.next(`<${i}.${round}>`));
    }
    const forward = new Y.Doc();
    const reversed = new Y.Doc();
    const shuffled = new Y.Doc();
    for (const u of updates) apply(forward, u);
    for (const u of [...updates].reverse()) apply(reversed, u);
    const order = updates.map((_, i) => (i * 7) % updates.length).filter((v, i, a) => a.indexOf(v) === i);
    for (const i of order) apply(shuffled, updates[i]);
    for (const u of updates) apply(shuffled, u); // anything the permutation missed

    expect(textOf(forward)).toBe(textOf(reversed));
    expect(textOf(forward)).toBe(textOf(shuffled));
    for (let i = 0; i < 3; i++) for (let r = 0; r < 6; r++) expect(textOf(forward)).toContain(`<${i}.${r}>`);
  });

  it('are held back, not lost, when an earlier update from the same user is missing', () => {
    const typist = new Typist(777);
    const [u1, u2, u3] = [typist.next('one '), typist.next('two '), typist.next('three')];
    const doc = new Y.Doc();
    apply(doc, u1);
    apply(doc, u3); // u2 never arrived: u3 cannot be placed yet
    expect(textOf(doc)).toBe('one ');
    apply(doc, u2);
    expect(textOf(doc)).toBe('one two three');
  });

  it('can be re-sent from what a server reports having, which is how a reconnecting VU repairs a gap', () => {
    const typist = new Typist(888);
    const sent = [typist.next('a'), typist.next('b'), typist.next('c'), typist.next('d')];
    const server = new Y.Doc();
    apply(server, sent[0]);
    apply(server, sent[1]); // the connection dies here: c and d are lost
    const have = parseStateVector(Y.encodeStateVector(server)).get(888) ?? 0;
    expect(have).toBe(2);
    for (const update of typist.missingFrom(have)) apply(server, update);
    expect(textOf(server)).toBe('abcd');
    expect(typist.missingFrom(4)).toEqual([]);
  });

  it('counts UTF-16 code units for the clock, as Yjs does, including for non-ASCII text', () => {
    const typist = new Typist(55);
    const doc = new Y.Doc();
    apply(doc, typist.next('héllo '));
    apply(doc, typist.next('wörld ✓'));
    expect(textOf(doc)).toBe('héllo wörld ✓');
    expect(typist.clock).toBe('héllo wörld ✓'.length);
  });
});

describe('markers', () => {
  it('survive the server re-encoding the update, which is how receivers read them', () => {
    const typist = new Typist(999);
    const tag = marker(1_791_500_000_123, 12, 34, 2);
    const doc = new Y.Doc();
    let reencoded;
    doc.on('update', (u) => (reencoded = u)); // what the gateway actually broadcasts
    apply(doc, typist.next(`word ${tag} `));
    const found = extractMarkers(encodeDocUpdate(reencoded));
    expect(found).toEqual([{ sentAt: 1_791_500_000_123, vu: 12, seq: 34, instance: 2 }]);
  });

  it('are found even when several are batched into one update', () => {
    const typist = new Typist(1);
    const bytes = typist.next(`${marker(1_791_500_000_001, 1, 1, 1)} ${marker(1_791_500_000_002, 1, 2, 3)}`);
    expect(extractMarkers(bytes).map((m) => m.seq)).toEqual([1, 2]);
  });

  it('ignore frames that merely look similar', () => {
    expect(extractMarkers(new TextEncoder().encode('@123:4:5:6@ @1791500000000:x:1:1@'))).toEqual([]);
  });
});

describe('frames', () => {
  it('HELLO decodes as a v3 hello for the room, with and without a resume token', () => {
    const plain = decode(frameHello('room-1', null));
    expect(plain).toMatchObject({ type: MessageType.Hello, protocolVersion: 3, roomId: 'room-1', resumeToken: null });
    const resumed = decode(frameHello('room-1', Uint8Array.from([9, 8, 7])));
    expect(Array.from(resumed.resumeToken)).toEqual([9, 8, 7]);
  });

  it('SYNC_STEP1, DOC_UPDATE, PONG, and PRESENCE decode as the server expects them', () => {
    expect(decode(frameSyncStep1())).toMatchObject({ type: MessageType.SyncStep1 });
    expect(Array.from(decode(frameSyncStep1()).stateVector)).toEqual([0]);
    expect(decode(framePong())).toEqual({ type: MessageType.Pong });
    const typist = new Typist(5);
    const update = typist.next('x');
    expect(Array.from(decode(frameDocUpdate(update)).update)).toEqual(Array.from(update));
    expect(decode(framePresence('Load User 7', '#2563eb'))).toMatchObject({
      type: MessageType.PresenceUpdate,
      value: { displayName: 'Load User 7', color: '#2563eb', cursor: null, selection: null },
    });
  });

  it('reads a real WELCOME, including the heartbeat interval', () => {
    const parsed = parseFrame(encodeWelcome('client-abc', true, 15000));
    expect(parsed).toEqual({ type: 'welcome', clientId: 'client-abc', resumed: true, heartbeatMs: 15000 });
  });

  it('reads a state vector the server would send', () => {
    const doc = new Y.Doc();
    doc.clientID = 4_000_000_000;
    doc.getText('content').insert(0, 'abc');
    expect(parseStateVector(Y.encodeStateVector(doc)).get(4_000_000_000)).toBe(3);
  });
});
