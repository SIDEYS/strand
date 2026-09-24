import { MessageType, PROTOCOL_VERSION } from './types.js';

/** Thrown by decode() on any malformed frame. The gateway catches this at a
 * single boundary and closes the connection with CloseCode.BadMessage —
 * callers should not need to distinguish sub-cases. */
export class ProtocolDecodeError extends Error {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeString(chunks: Uint8Array[], value: string): void {
  const bytes = textEncoder.encode(value);
  if (bytes.length > 0xffff) {
    throw new ProtocolDecodeError(`string field too long: ${bytes.length} bytes`);
  }
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length, false);
  chunks.push(len, bytes);
}

function concat(chunks: Uint8Array[]): Uint8Array {
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
class Reader {
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

  string(): string {
    if (this.remaining < 2) throw new ProtocolDecodeError('truncated: expected string length');
    const len = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    if (this.remaining < len) throw new ProtocolDecodeError('truncated: expected string bytes');
    const bytes = this.#bytes.subarray(this.#offset, this.#offset + len);
    this.#offset += len;
    return textDecoder.decode(bytes);
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
  | { type: typeof MessageType.Hello; protocolVersion: number; roomId: string | null }
  | { type: typeof MessageType.Welcome; clientId: string }
  | { type: typeof MessageType.Ping }
  | { type: typeof MessageType.Pong }
  | { type: typeof MessageType.Message; payload: Uint8Array };

export function encodeHello(roomId: string, protocolVersion = PROTOCOL_VERSION): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.Hello, protocolVersion])];
  writeString(chunks, roomId);
  return concat(chunks);
}

export function encodeWelcome(clientId: string): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([MessageType.Welcome])];
  writeString(chunks, clientId);
  return concat(chunks);
}

export function encodePing(): Uint8Array {
  return new Uint8Array([MessageType.Ping]);
}

export function encodePong(): Uint8Array {
  return new Uint8Array([MessageType.Pong]);
}

export function encodeMessage(payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array([MessageType.Message]), payload]);
}

export function decode(bytes: Uint8Array): DecodedMessage {
  if (bytes.length === 0) throw new ProtocolDecodeError('empty frame');
  const reader = new Reader(bytes);
  const type = reader.u8();

  switch (type) {
    case MessageType.Hello: {
      const protocolVersion = reader.u8();
      if (protocolVersion !== PROTOCOL_VERSION) {
        return { type: MessageType.Hello, protocolVersion, roomId: null };
      }
      const roomId = reader.string();
      return { type: MessageType.Hello, protocolVersion, roomId };
    }
    case MessageType.Welcome: {
      const clientId = reader.string();
      return { type: MessageType.Welcome, clientId };
    }
    case MessageType.Ping:
      return { type: MessageType.Ping };
    case MessageType.Pong:
      return { type: MessageType.Pong };
    case MessageType.Message: {
      const payload = reader.rest();
      return { type: MessageType.Message, payload };
    }
    default:
      throw new ProtocolDecodeError(`unknown message type: 0x${type.toString(16)}`);
  }
}
