import type { PresenceValue } from '../presence/types.js';
import { MessageType, PROTOCOL_VERSION } from './types.js';

/** Thrown by decode() on any malformed frame. The gateway catches this at a
 * single boundary and closes the connection with CloseCode.BadMessage —
 * callers should not need to distinguish sub-cases. */
export class ProtocolDecodeError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function writeString(chunks: Uint8Array[], value: string): void {
  const bytes = textEncoder.encode(value);
  if (bytes.length > 0xffff) {
    throw new ProtocolDecodeError(`string field too long: ${bytes.length} bytes`);
  }
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length, false);
  chunks.push(len, bytes);
}

export function writeU32(chunks: Uint8Array[], value: number): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  chunks.push(bytes);
}

/** Timestamps are epoch milliseconds (Date.now()-range), which overflows
 * u32 — encoded as u64 on the wire but kept as `number` everywhere in TS,
 * since epoch-ms values are always well within Number.MAX_SAFE_INTEGER. */
export function writeU64(chunks: Uint8Array[], value: number): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  chunks.push(bytes);
}

/** Longest encoded relative position accepted. They are ~10-20 bytes; the cap
 * just keeps a hostile length prefix from being believed. */
const MAX_POSITION_BYTES = 256;

function writePosition(chunks: Uint8Array[], position: Uint8Array): void {
  if (position.length > MAX_POSITION_BYTES) {
    throw new ProtocolDecodeError(`position too long: ${position.length} bytes`);
  }
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, position.length, false);
  chunks.push(len, position);
}

function writePresenceValue(chunks: Uint8Array[], value: PresenceValue): void {
  writeString(chunks, value.displayName);
  writeString(chunks, value.color);
  if (value.cursor === null) {
    chunks.push(new Uint8Array([0]));
  } else {
    chunks.push(new Uint8Array([1]));
    writePosition(chunks, value.cursor);
  }
  if (value.selection === null) {
    chunks.push(new Uint8Array([0]));
  } else {
    chunks.push(new Uint8Array([1]));
    writePosition(chunks, value.selection.anchor);
    writePosition(chunks, value.selection.head);
  }
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Cursor over a Uint8Array with bounds-checked reads. Every read throws
 * ProtocolDecodeError instead of returning undefined/NaN on a truncated
 * buffer, so decode() never has to null-check its way through a payload. */
export class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  u8(): number {
    if (this.remaining < 1) throw new ProtocolDecodeError('truncated: expected u8');
    const v = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return v;
  }

  u16(): number {
    if (this.remaining < 2) throw new ProtocolDecodeError('truncated: expected u16');
    const v = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    return v;
  }

  u32(): number {
    if (this.remaining < 4) throw new ProtocolDecodeError('truncated: expected u32');
    const v = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return v;
  }

  u64(): number {
    if (this.remaining < 8) throw new ProtocolDecodeError('truncated: expected u64');
    const v = this.#view.getBigUint64(this.#offset, false);
    this.#offset += 8;
    return Number(v);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  string(): string {
    if (this.remaining < 2) throw new ProtocolDecodeError('truncated: expected string length');
    const len = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    if (this.remaining < len) throw new ProtocolDecodeError('truncated: expected string bytes');
    const bytes = this.#bytes.subarray(this.#offset, this.#offset + len);
    this.#offset += len;
    return textDecoder.decode(bytes);
  }

  position(): Uint8Array {
    const length = this.u16();
    if (length > MAX_POSITION_BYTES) throw new ProtocolDecodeError(`position too long: ${length} bytes`);
    // Copied: the frame's buffer is reused by the transport.
    return this.bytes(length).slice();
  }

  presenceValue(): PresenceValue {
    const displayName = this.string();
    const color = this.string();
    const cursor = this.bool() ? this.position() : null;
    const selection = this.bool() ? { anchor: this.position(), head: this.position() } : null;
    return { displayName, color, cursor, selection };
  }

  bytes(length: number): Uint8Array {
    if (this.remaining < length) throw new ProtocolDecodeError('truncated: expected bytes');
    const out = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  rest(): Uint8Array {
    const bytes = this.#bytes.subarray(this.#offset);
    this.#offset = this.#bytes.length;
    return bytes;
  }
}

export type DecodedMessage =
  // roomId is null when protocolVersion doesn't match ours: a future
  // version's HELLO payload might not even be laid out as [u16 len][utf8],
  // so we deliberately stop reading right after the version byte instead of
  // guessing at a schema we don't know.
  | {
      type: typeof MessageType.Hello;
      protocolVersion: number;
      roomId: string | null;
      /** Null when absent, and also when the version didn't match. */
      resumeToken: Uint8Array | null;
    }
  | {
      type: typeof MessageType.Welcome;
      clientId: string;
      resumed: boolean;
      /** How often the server pings this connection. The client derives its
       * own liveness timeout from it, so a silent connection is recognised as
       * useless without waiting for the socket to notice. */
      heartbeatIntervalMs: number;
    }
  | { type: typeof MessageType.Ping }
  | { type: typeof MessageType.Pong }
  | { type: typeof MessageType.ResumeToken; token: Uint8Array }
  | { type: typeof MessageType.SyncStep1; stateVector: Uint8Array }
  | { type: typeof MessageType.SyncStep2; update: Uint8Array }
  | { type: typeof MessageType.DocUpdate; update: Uint8Array }
  | { type: typeof MessageType.PresenceUpdate; value: PresenceValue }
  | { type: typeof MessageType.PresenceBroadcast; clientId: string; timestamp: number; value: PresenceValue }
  | { type: typeof MessageType.PresenceRemove; clientId: string; timestamp: number };

/** Longest resume token HELLO will carry. Tokens are ~100 bytes; this just
 * keeps a hostile length prefix from being believed. */
const MAX_RESUME_TOKEN_BYTES = 512;

export function encodeHello(
  roomId: string,
  protocolVersion = PROTOCOL_VERSION,
  resumeToken?: Uint8Array,
): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.Hello, protocolVersion])];
  writeString(chunks, roomId);
  const token = resumeToken ?? new Uint8Array();
  if (token.length > MAX_RESUME_TOKEN_BYTES) {
    throw new ProtocolDecodeError(`resume token too long: ${token.length} bytes`);
  }
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, token.length, false);
  chunks.push(len, token);
  return concat(chunks);
}

export function encodeWelcome(clientId: string, resumed = false, heartbeatIntervalMs = 0): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.Welcome])];
  writeString(chunks, clientId);
  chunks.push(new Uint8Array([resumed ? 1 : 0]));
  writeU32(chunks, heartbeatIntervalMs);
  return concat(chunks);
}

export function encodeResumeToken(token: Uint8Array): Uint8Array {
  return concat([new Uint8Array([MessageType.ResumeToken]), token]);
}

export function encodePing(): Uint8Array {
  return new Uint8Array([MessageType.Ping]);
}

export function encodePong(): Uint8Array {
  return new Uint8Array([MessageType.Pong]);
}

export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  return concat([new Uint8Array([MessageType.SyncStep1]), stateVector]);
}

export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  return concat([new Uint8Array([MessageType.SyncStep2]), update]);
}

export function encodeDocUpdate(update: Uint8Array): Uint8Array {
  return concat([new Uint8Array([MessageType.DocUpdate]), update]);
}

export function encodePresenceUpdate(value: PresenceValue): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.PresenceUpdate])];
  writePresenceValue(chunks, value);
  return concat(chunks);
}

export function encodePresenceBroadcast(clientId: string, timestamp: number, value: PresenceValue): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.PresenceBroadcast])];
  writeString(chunks, clientId);
  writeU64(chunks, timestamp);
  writePresenceValue(chunks, value);
  return concat(chunks);
}

export function encodePresenceRemove(clientId: string, timestamp: number): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.PresenceRemove])];
  writeString(chunks, clientId);
  writeU64(chunks, timestamp);
  return concat(chunks);
}

export function decode(bytes: Uint8Array): DecodedMessage {
  if (bytes.length === 0) throw new ProtocolDecodeError('empty frame');
  const reader = new Reader(bytes);
  const type = reader.u8();

  switch (type) {
    case MessageType.Hello: {
      const protocolVersion = reader.u8();
      if (protocolVersion !== PROTOCOL_VERSION) {
        return { type: MessageType.Hello, protocolVersion, roomId: null, resumeToken: null };
      }
      const roomId = reader.string();
      const tokenLength = reader.u16();
      if (tokenLength > MAX_RESUME_TOKEN_BYTES) {
        throw new ProtocolDecodeError(`resume token too long: ${tokenLength} bytes`);
      }
      const resumeToken = tokenLength === 0 ? null : reader.bytes(tokenLength);
      return { type: MessageType.Hello, protocolVersion, roomId, resumeToken };
    }
    case MessageType.Welcome: {
      const clientId = reader.string();
      const resumed = reader.bool();
      const heartbeatIntervalMs = reader.u32();
      return { type: MessageType.Welcome, clientId, resumed, heartbeatIntervalMs };
    }
    case MessageType.Ping:
      return { type: MessageType.Ping };
    case MessageType.Pong:
      return { type: MessageType.Pong };
    case MessageType.ResumeToken:
      return { type: MessageType.ResumeToken, token: reader.rest() };
    case MessageType.SyncStep1:
      return { type: MessageType.SyncStep1, stateVector: reader.rest() };
    case MessageType.SyncStep2:
      return { type: MessageType.SyncStep2, update: reader.rest() };
    case MessageType.DocUpdate:
      return { type: MessageType.DocUpdate, update: reader.rest() };
    case MessageType.PresenceUpdate:
      return { type: MessageType.PresenceUpdate, value: reader.presenceValue() };
    case MessageType.PresenceBroadcast: {
      const clientId = reader.string();
      const timestamp = reader.u64();
      const value = reader.presenceValue();
      return { type: MessageType.PresenceBroadcast, clientId, timestamp, value };
    }
    case MessageType.PresenceRemove: {
      const clientId = reader.string();
      const timestamp = reader.u64();
      return { type: MessageType.PresenceRemove, clientId, timestamp };
    }
    default:
      throw new ProtocolDecodeError(`unknown message type: 0x${type.toString(16)}`);
  }
}
