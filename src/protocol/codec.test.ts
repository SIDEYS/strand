import { describe, expect, it } from 'vitest';
import type { PresenceValue } from '../presence/types.js';
import {
  ProtocolDecodeError,
  decode,
  encodeDocUpdate,
  encodeHello,
  encodePing,
  encodePong,
  encodePresenceBroadcast,
  encodePresenceRemove,
  encodePresenceUpdate,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeWelcome,
} from './codec.js';
import { MessageType, PROTOCOL_VERSION } from './types.js';

describe('protocol codec', () => {
  it('round-trips HELLO with the current protocol version', () => {
    const bytes = encodeHello('room-42');
    const msg = decode(bytes);
    expect(msg).toEqual({
      type: MessageType.Hello,
      protocolVersion: PROTOCOL_VERSION,
      roomId: 'room-42',
    });
  });

  it('stops parsing a HELLO with a mismatched protocol version instead of reading roomId', () => {
    const bytes = encodeHello('room-42', 99);
    const msg = decode(bytes);
    expect(msg).toEqual({ type: MessageType.Hello, protocolVersion: 99, roomId: null });
  });

  it('round-trips WELCOME', () => {
    const bytes = encodeWelcome('client-abc');
    expect(decode(bytes)).toEqual({ type: MessageType.Welcome, clientId: 'client-abc' });
  });

  it('round-trips PING and PONG with no payload', () => {
    expect(decode(encodePing())).toEqual({ type: MessageType.Ping });
    expect(decode(encodePong())).toEqual({ type: MessageType.Pong });
  });

  it('round-trips non-ASCII strings', () => {
    const bytes = encodeHello('room-日本語-🎉');
    expect(decode(bytes)).toMatchObject({ roomId: 'room-日本語-🎉' });
  });

  it('rejects an empty frame', () => {
    expect(() => decode(new Uint8Array())).toThrow(ProtocolDecodeError);
  });

  it('rejects an unknown message type', () => {
    expect(() => decode(new Uint8Array([0xff]))).toThrow(ProtocolDecodeError);
  });

  it('rejects a HELLO truncated before its room id', () => {
    const full = encodeHello('room-42');
    const truncated = full.subarray(0, 4);
    expect(() => decode(truncated)).toThrow(ProtocolDecodeError);
  });

  it('rejects a string length prefix that overruns the buffer', () => {
    // type=Welcome, length=0x00FF (255) but no bytes follow
    const bytes = new Uint8Array([MessageType.Welcome, 0x00, 0xff]);
    expect(() => decode(bytes)).toThrow(ProtocolDecodeError);
  });
});

describe('protocol codec: Yjs sync and document updates', () => {
  it('round-trips SYNC_STEP1', () => {
    const stateVector = new Uint8Array([9, 8, 7]);
    const decoded = decode(encodeSyncStep1(stateVector));
    expect(decoded.type).toBe(MessageType.SyncStep1);
    if (decoded.type !== MessageType.SyncStep1) throw new Error('unreachable');
    expect(Array.from(decoded.stateVector)).toEqual([9, 8, 7]);
  });

  it('round-trips SYNC_STEP2', () => {
    const update = new Uint8Array([1, 2, 3]);
    const decoded = decode(encodeSyncStep2(update));
    expect(decoded.type).toBe(MessageType.SyncStep2);
    if (decoded.type !== MessageType.SyncStep2) throw new Error('unreachable');
    expect(Array.from(decoded.update)).toEqual([1, 2, 3]);
  });

  it('round-trips an opaque DOC_UPDATE payload', () => {
    const update = new Uint8Array([1, 2, 3, 255, 0]);
    const decoded = decode(encodeDocUpdate(update));
    expect(decoded.type).toBe(MessageType.DocUpdate);
    if (decoded.type !== MessageType.DocUpdate) throw new Error('unreachable');
    expect(Array.from(decoded.update)).toEqual(Array.from(update));
  });
});

describe('protocol codec: presence', () => {
  const full: PresenceValue = {
    displayName: 'Ada',
    color: '#ff00ff',
    cursor: 42,
    selection: { anchor: 10, head: 20 },
  };
  const empty: PresenceValue = {
    displayName: 'Ada',
    color: '#ff00ff',
    cursor: null,
    selection: null,
  };

  it('round-trips PRESENCE_UPDATE with cursor and selection present', () => {
    const decoded = decode(encodePresenceUpdate(full));
    expect(decoded).toEqual({ type: MessageType.PresenceUpdate, value: full });
  });

  it('round-trips PRESENCE_UPDATE with cursor and selection absent', () => {
    const decoded = decode(encodePresenceUpdate(empty));
    expect(decoded).toEqual({ type: MessageType.PresenceUpdate, value: empty });
  });

  it('round-trips PRESENCE_BROADCAST including clientId and a large (epoch-ms) timestamp', () => {
    const timestamp = Date.now();
    const decoded = decode(encodePresenceBroadcast('client-abc', timestamp, full));
    expect(decoded).toEqual({
      type: MessageType.PresenceBroadcast,
      clientId: 'client-abc',
      timestamp,
      value: full,
    });
  });

  it('round-trips PRESENCE_REMOVE', () => {
    const timestamp = Date.now();
    const decoded = decode(encodePresenceRemove('client-abc', timestamp));
    expect(decoded).toEqual({ type: MessageType.PresenceRemove, clientId: 'client-abc', timestamp });
  });
});
