// Wire-protocol helpers for the load generator.
//
// A plain ES module with NO imports, because it has to run inside k6's JS
// runtime (no Node, no npm) and also under Node for its own tests. That is
// also why it hand-encodes Yjs updates instead of using the Yjs library:
// k6 cannot load it. The encoder is checked against the real Yjs and the real
// protocol codec in frames.test.mjs, so it is not trusted on faith.

export const T = {
  Hello: 0x01,
  Welcome: 0x02,
  Ping: 0x03,
  Pong: 0x04,
  ResumeToken: 0x05,
  SyncStep1: 0x10,
  SyncStep2: 0x11,
  DocUpdate: 0x12,
  PresenceUpdate: 0x20,
  PresenceBroadcast: 0x21,
  PresenceRemove: 0x22,
};

export const PROTOCOL_VERSION = 3;

// ---- primitives --------------------------------------------------------------------------

function utf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return bytes;
}

/** lib0's writeVarUint: 7 bits per byte, high bit means "more follows". Uses
 * division, not shifts, so values past 2^31 (Yjs client IDs are 32-bit) work. */
export function varUint(value, out) {
  let n = value;
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function varString(str, out) {
  const bytes = utf8(str);
  varUint(bytes.length, out);
  for (const b of bytes) out.push(b);
}

function u16(value, out) {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function u16String(str, out) {
  const bytes = utf8(str);
  u16(bytes.length, out);
  for (const b of bytes) out.push(b);
}

// ---- Yjs updates --------------------------------------------------------------------------

/**
 * Produces valid Yjs v1 updates for one simulated user typing into the shared
 * text `content`, without a Yjs document. Each update inserts a string after
 * the user's own previous character (the first goes to the root), which is
 * exactly what a person typing at their own cursor produces, and keeps every
 * update causally dependent only on that user's earlier ones.
 *
 * It remembers what it sent so it can re-send anything a server turns out to be
 * missing after a reconnect, the way the real client does with a state-vector
 * exchange. Without that, one lost update would leave every later one waiting
 * on it forever, which would be a flaw in the generator, not the system.
 */
export class Typist {
  constructor(clientId) {
    this.clientId = clientId;
    this.clock = 0;
    this.history = [];
  }

  next(text) {
    const out = [];
    varUint(1, out); // one client section
    varUint(1, out); // with one struct
    varUint(this.clientId, out);
    varUint(this.clock, out); // clock of that struct
    const hasOrigin = this.clock > 0;
    out.push((hasOrigin ? 0x80 : 0) | 4); // BIT8: has origin; low bits: content ref 4 = string
    if (hasOrigin) {
      varUint(this.clientId, out); // origin = my previous character
      varUint(this.clock - 1, out);
    } else {
      varUint(1, out); // parent is a root type, named by key
      varString('content', out);
    }
    varString(text, out);
    varUint(0, out); // empty delete set
    const bytes = Uint8Array.from(out);
    this.history.push({ start: this.clock, end: this.clock + text.length, bytes });
    this.clock += text.length; // Yjs counts UTF-16 code units
    return bytes;
  }

  /** Updates a server holding `have` of this user's clock is missing. */
  missingFrom(have) {
    return this.history.filter((entry) => entry.end > have).map((entry) => entry.bytes);
  }
}

/** Decodes a Yjs state vector into a Map(client -> clock). */
export function parseStateVector(bytes) {
  const map = new Map();
  let pos = 0;
  const read = () => {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = bytes[pos++];
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
  };
  const count = read();
  for (let i = 0; i < count; i++) {
    const client = read();
    map.set(client, read());
  }
  return map;
}

// ---- markers ------------------------------------------------------------------------------------

const MARKER = /@(\d{13}):(\d+):(\d+):(\d+)@/g;

export function marker(sentAt, vu, seq, instance) {
  return `@${sentAt}:${vu}:${seq}:${instance}@`;
}

/** Finds the markers in a frame's bytes. Update content is stored as plain
 * UTF-8 inside the update, so scanning the bytes is enough. */
export function extractMarkers(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const found = [];
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(text)) !== null) {
    found.push({ sentAt: Number(m[1]), vu: Number(m[2]), seq: Number(m[3]), instance: Number(m[4]) });
  }
  return found;
}

// ---- frames the generator sends --------------------------------------------------------------

export function frameHello(roomId, token) {
  const out = [T.Hello, PROTOCOL_VERSION];
  u16String(roomId, out);
  const tokenBytes = token ? Array.from(token) : [];
  u16(tokenBytes.length, out);
  for (const b of tokenBytes) out.push(b);
  return Uint8Array.from(out);
}

/** SyncStep1 with an empty state vector: "I hold nothing, send me the room". */
export function frameSyncStep1() {
  return Uint8Array.from([T.SyncStep1, 0]);
}

export function frameDocUpdate(update) {
  const out = new Uint8Array(update.length + 1);
  out[0] = T.DocUpdate;
  out.set(update, 1);
  return out;
}

export function framePong() {
  return Uint8Array.from([T.Pong]);
}

export function framePresence(displayName, color) {
  const out = [T.PresenceUpdate];
  u16String(displayName, out);
  u16String(color, out);
  out.push(0, 0); // no cursor, no selection
  return Uint8Array.from(out);
}

// ---- frames the generator reads ----------------------------------------------------------------

export function parseFrame(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  switch (b[0]) {
    case T.Welcome: {
      const len = (b[1] << 8) | b[2];
      let clientId = '';
      for (let i = 0; i < len; i++) clientId += String.fromCharCode(b[3 + i]);
      const at = 3 + len;
      const heartbeatMs = (b[at + 1] * 16777216) + ((b[at + 2] << 16) | (b[at + 3] << 8) | b[at + 4]);
      return { type: 'welcome', clientId, resumed: b[at] === 1, heartbeatMs };
    }
    case T.ResumeToken:
      return { type: 'resume-token', token: b.slice(1) };
    case T.Ping:
      return { type: 'ping' };
    case T.SyncStep1:
      return { type: 'sync-step1', stateVector: parseStateVector(b.subarray(1)) };
    case T.SyncStep2:
      return { type: 'sync-step2', update: b.subarray(1) };
    case T.DocUpdate:
      return { type: 'doc-update', update: b.subarray(1) };
    case T.PresenceBroadcast:
      return { type: 'presence' };
    case T.PresenceRemove:
      return { type: 'presence-remove' };
    default:
      return { type: 'unknown', code: b[0] };
  }
}
