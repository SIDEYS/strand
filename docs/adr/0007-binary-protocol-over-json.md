# ADR 0007: A small binary protocol instead of JSON

## Context

The client and server exchange a handful of message types: a handshake, state
vector sync, document updates, presence, and liveness. The payload that matters
most, a Yjs update, is already a compact binary encoding. The question is what
to wrap around it.

## Options considered

**JSON text frames.** Self-describing, easy to read in browser dev tools, no
codec to write. But a Yjs update is bytes, and bytes in JSON mean base64, which
inflates every document update by a third plus the field names around it. Every
other field then also needs a decision about numbers and escaping.

**A schema-based binary format (Protocol Buffers, MessagePack, CBOR).** Real
options, and for a larger protocol I would reach for one. For roughly a dozen
message types with one binary blob each, a dependency plus a build step (or a
runtime library shipped to every browser) buys little over a small hand-written
length-prefixed codec, and adds a surface the codec's own tests would have
to treat as a black box.

**Hand-rolled binary: one type byte, then a payload per type** (chosen). The
Yjs update goes in as raw bytes. Strings and byte arrays are length-prefixed,
integers fixed-width. The whole codec is one file (`src/protocol/codec.ts`) with
a round-trip test for every message and tests for malformed input.

## Decision

Each frame is `[type: u8][payload]`, defined in `src/protocol/types.ts` and
`codec.ts`.

- **Version lives only in HELLO.** Once a connection is past HELLO and WELCOME,
  both sides are known to speak the same version, so repeating it per frame
  would be dead weight. A server that does not speak the client's version closes
  with `ProtocolVersionMismatch` (4001) before parsing anything else, and the
  client treats that as fatal rather than retrying, because the same HELLO would
  fail the same way forever.
- **Strict decoding.** Empty frames, unknown type bytes, truncated payloads and
  length prefixes that overrun the buffer (including absurd token and position
  lengths) are `BadMessage` (4004); what the decoder does with extra bytes after a
  complete message is not tested; a frame over 64 KiB is `MessageTooLarge`
  (4005), enforced before decoding.
- **The server stamps what clients cannot be trusted to supply.** Presence
  frames from a client carry no ID or timestamp (ADR 0001).

Measured with the shipped encoder, against a JSON equivalent I wrote for the
comparison (a `type` field plus base64 or plain fields; a real JSON protocol
would differ in detail but not in kind):

| Message | Binary | JSON |
|---|---|---|
| Document update, one typed character (21-byte Yjs update) | 22 B | 61 B |
| Document update, 34-character document (54-byte Yjs update) | 55 B | 105 B |
| Presence update (name, colour, no cursor) | 23 B | 94 B |
| Ping | 1 B | 15 B |

Document updates dominate traffic and the frame is 48 to 64% smaller on the
small edits measured above. It is not an order of magnitude; the honest case for binary here is
"smaller, cheaper to parse, and no base64 round trip for a payload that is
already bytes", not "JSON would not work".

## Consequences

- **Harder to debug.** You cannot read a frame in dev tools. Mitigations: the
  codec is small and covered by round-trip and malformed-input tests, and the load generator's own encoder
  (`loadtest/lib/frames.mjs`) is tested against the real codec, so there are two
  independent implementations agreeing on the format.
- **Evolution is explicit.** There is no field-by-field forward compatibility as
  in Protocol Buffers. Changing a layout means bumping `PROTOCOL_VERSION`, which
  has happened twice (v2 added resume tokens, v3 changed presence positions to
  encoded relative positions and put the heartbeat interval in WELCOME). The cost
  is that old clients are turned away rather than half-understood, which is the
  safer failure for a collaborative editor.
- **A second implementation must match byte for byte.** Anyone writing another
  client reads `codec.ts`. If the protocol grew past a few dozen message types, a
  schema language would start to pay for itself and this decision should be
  revisited.
