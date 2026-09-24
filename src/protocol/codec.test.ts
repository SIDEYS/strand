import { describe, expect, it } from 'vitest';
import {
  ProtocolDecodeError,
  decode,
  encodeHello,
  encodeMessage,
  encodePing,
  encodePong,
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

  it('round-trips an opaque MESSAGE payload', () => {
    const payload = new Uint8Array([1, 2, 3, 255, 0]);
    const decoded = decode(encodeMessage(payload));
    expect(decoded.type).toBe(MessageType.Message);
    if (decoded.type !== MessageType.Message) throw new Error('unreachable');
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
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
