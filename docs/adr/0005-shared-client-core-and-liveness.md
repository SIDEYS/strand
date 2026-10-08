# ADR 0005: One client core shared by the browser and the tests; offline driven by liveness; cursors as relative positions

## Context

Three decisions in the client share a theme: do not let the thing that is
tested diverge from the thing that ships, and do not trust a signal that lies.

- Through Phase 4 the integration tests used a test-only client that
  reimplemented the handshake, resume, and sync logic. The real browser client
  was about to be a second implementation of the same thing.
- A WebSocket can stay "open" through a dead network for as long as the OS
  takes to give up, so the socket's own state is a poor source for "offline".
- A remote cursor shown as a character offset is wrong the moment someone else
  edits the document above it.

## Decisions

### 1. A socket-agnostic core, with the environment injected

`src/client/core.ts` owns the handshake, resume, sync, reconnect policy,
liveness, and message dispatch. It owns **no DOM, no React, and no
environment**: it is constructed with a socket factory, a scheduler (`now`,
`setTimeout`, `clearTimeout`), and a source of randomness.

| Runs in | Socket | Time | Randomness |
|---|---|---|---|
| Browser | native `WebSocket` | window timers | `Math.random` |
| Integration tests | `ws` | system clock | seeded |
| Unit tests | in-memory fake | a clock advanced by hand | fixed |

The same code runs in all three, so a green integration suite says something
about the client users actually run. The earlier arrangement (a parallel test
client) is how a suite goes green while the real client is broken. After the
change, deliberately breaking the core's handover of offline edits fails three
real-infrastructure tests.

The injected clock is what keeps the timing tests honest. Backoff schedules,
the liveness watchdog, and the handshake timeout are asserted to the
millisecond by advancing a fake clock, with no sleeping and so no flakiness.

The boundary is **enforced, not conventional**: ESLint fails the build if
anything under `src/client` references a timer, `Date`, `Math.random`, a
global `WebSocket`, the DOM, `console`, a Node built-in, or React. (Checked by
planting violations.) The reconnect policy itself lives in
`src/protocol/reconnect.ts` as pure functions, and presence merging is the same
LWW set the server uses.

### 2. "Offline" means the connection is useless, not that the socket closed

The server pings every `heartbeatIntervalMs`, and reports that interval in
`WELCOME`. The client treats a connection that has been silent for longer than
one missed ping plus slack (`1.5 × interval + 1s`) as dead: it abandons the
socket, retries with backoff, and reports **offline** until a handshake
actually completes. A connect that never completes gets the same treatment
after a handshake timeout, instead of waiting for the OS.

This was verified in a real browser by freezing the server process
(`SIGSTOP`), which keeps every socket open and silent. The status pill changed
to Offline about 3 seconds later (with a 2 s heartbeat), with no intermediate
"reconnecting" state, because nothing had told the socket anything.

**The cost is detection latency**: about 1.5 heartbeat intervals. With the
default 15 s interval that is roughly 24 s before the UI says offline. A
shorter server interval buys faster detection with more traffic; a
client-initiated probe would be sharper still but needs a protocol addition.
Editing is never blocked while waiting: offline typing always works locally,
and the state-vector resync recovers anything handed to a dead socket in the
gap before it was noticed (there is a test for exactly that).

### 3. Cursors are Yjs relative positions end to end

A cursor travels as an encoded `RelativePosition`, anchored to a character's
identity rather than an index. A remote caret therefore stays on the same
character while text is inserted above it, in whichever replica it is resolved.
The server and the LWW set treat it as opaque bytes. This is a wire change
(protocol v3). Verified live: a caret stayed on its character after text was
inserted above it.

`y-codemirror.next` takes an awareness-shaped object. We implement that narrow
interface (`doc.clientID`, `getStates`, `getLocalState`, `setLocalStateField`,
`on`/`off('change')`) over our own LWW presence set. The awareness protocol and
state machine are not used, so presence stays a server-stamped LWW set (ADR
0001). One thing worth knowing: Yjs's own `compareRelativePositions` is
structural and treats an encoded-then-decoded position as different from the
original (the encoding drops a redundant type name), so positions are compared
by where they resolve.

### 4. The demo room is seeded with an idempotent update

Several instances can create the demo room independently, so seeding must be
safe from any instance, any number of times. The seed is a Yjs update with a
fixed client ID and fixed text: byte-identical everywhere, so applying it is
idempotent, and because deleted items are remembered by ID it can never
resurrect text a user deleted. The seed content says what to try (open a second
window, kill your wifi, keep typing).

## Consequences

- The client core can be exercised without a browser, a network, or time. The
  browser shell (`web/`) is thin and carries no protocol logic.
- Heartbeat liveness is a latency trade-off, not a free lunch (above).
- Offline edits live in memory in the page. A reload while offline loses
  them; persisting the local document (for example to IndexedDB) is not done.
- Scroll sync is proportional, not tied to source lines. It is approximate on
  documents whose rendered and source heights differ a lot.
- The editor binding and the awareness adapter rely on `y-codemirror.next`'s
  internal use of the awareness interface; an upgrade that widens what it calls
  would need the adapter to follow.
