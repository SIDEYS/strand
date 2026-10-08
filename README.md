# Strand

A realtime collaborative Markdown editor built to run as several stateless
server instances behind a load balancer, with no sticky sessions. Multiple
people edit one document at once and see each other's cursors live.

Work in progress; the full write-up (architecture diagram, benchmarks,
limitations) arrives with the final phase.

## No sticky sessions needed

Any instance can serve any client in any room, and a client can reconnect to
a different instance at any time. This works because no instance is the
authority for a room, and nothing a client needs lives only on one instance:

- **Document text is a CRDT (Yjs).** Replicas that have seen the same set of
  updates are identical regardless of the order or number of times they
  arrived, so there is no "primary" copy to route a client to, and no
  sequencing server to be sticky *to*.
- **Instances reconcile with each other.** Redis pub/sub carries edits
  between instances quickly, but it can drop messages. So every few seconds
  each instance announces its state per room and peers send whatever the
  announcer is missing. A dropped message delays convergence; it cannot
  prevent it. See [ADR 0002](docs/adr/0002-fanout-pubsub-with-reconciliation.md).
- **A joining client resyncs from a state vector.** It says what it already
  has and the instance it landed on replies with only the difference, so
  landing on an instance that has never seen the room, or one that was
  briefly behind, is not a special case.
- **Presence expires on its own.** Each client's presence is refreshed in
  Redis on its heartbeat and expires by Redis's clock, so an instance that
  dies takes its clients' presence with it after one TTL instead of leaving
  ghosts, and no other instance has to notice it died.

The one thing sticky sessions would have bought is skipping all of this. The
price of doing without them is paid in the reconcile traffic and the bounded
window (about one reconcile interval) in which an instance recovering from
lost messages can show slightly stale content.

## Reconnecting

A client that drops comes back as the same person, on whichever instance the
load balancer picks. The server hands it a signed resume token (HMAC-SHA256
over client ID, room, and expiry; stateless, so any instance can verify it).
Because a stateless token can be presented twice, a Redis session lease
enforces one live connection per client ID: the newest connection wins and the
older one is closed with a `Superseded` code. See
[ADR 0003](docs/adr/0003-stateless-resume-tokens-with-lease-fencing.md) for why
the token is not revocable (and why that stops being acceptable the day the
service gets real auth).

After the handshake the server answers the client's state vector with only the
difference, then sends its own state vector so the client can send back only
what the server is missing. **Reconnect cost is proportional to what was
missed, not to the size of the document**, which is what makes a long offline
editing session practical. One caveat: Yjs includes a document's entire delete
set in every diff, so the part of the cost that comes from deletions scales
with how much has been deleted over the document's life, not with what was
missed. It is stored as compact ranges, but it is not zero.

The client's reconnect policy is a set of pure functions in
`src/protocol/reconnect.ts`, shared with the browser client. Close codes fall
into three classes: retry promptly (server shutting down), retry with jittered
exponential backoff (heartbeat timeout, transport failure), and never retry
(protocol version mismatch, malformed or oversized message, superseded).
Looping on a version mismatch would be a denial of service against your own
server, and two tabs that each reconnected after being superseded would evict
each other forever.

## The client

A split-pane Markdown editor (CodeMirror 6 on the left, a sanitised live preview
on the right, scrolled in step) with collaborators' cursors and selections drawn
in the source pane in their colour with a name label, a presence bar, a
connection indicator, a room picker, and a shareable URL per room (`/r/<room>`).
The `demo` room is seeded with a walkthrough that says what to try.

The part worth reading is how it is built. The protocol, resume, sync,
reconnect, and liveness logic lives in one framework-free core
(`src/client/core.ts`) that is handed its socket, its clock, and its randomness.
The browser passes the native `WebSocket` and window timers; the integration
tests pass `ws` and the system clock; the unit tests pass fakes and a clock they
advance by hand. So the tests exercise the code the browser actually runs, and
ESLint fails the build if the core reaches for a timer, `Date`, `Math.random`,
the DOM, a Node built-in, or React. See
[ADR 0005](docs/adr/0005-shared-client-core-and-liveness.md).

- **Cursors are relative positions**, not offsets, so a remote caret stays on the
  character it is on while someone inserts above it.
- **Offline is detected from heartbeat liveness**, not from the socket. A socket
  can stay open through a dead network, so a connection that goes silent is
  treated as dead and the indicator says so. Typing keeps working locally, the
  indicator counts the edits saved in the window, and they merge on reconnect.
- **The preview is an XSS sink** (it renders what other people typed) and goes
  through DOMPurify with scripts, event handlers, `javascript:` URLs, styles, and
  frames removed.

## Persistence

Rooms live in instance memory and are written to Postgres **behind** the edit
path: a keystroke never waits on the database. Each instance writes an update
to the op log only when one of *its own* clients produced it, so every edit is
logged exactly once with no election, lease, or deduplication. Any instance can
write a snapshot (a merge of the stored one and its own state, guarded by
compare-and-set on a version), which is what covers an originator that dies
before its buffer is flushed. The op log is unordered because Yjs updates
commute; each op is tagged with the snapshot version current when it was
written, and compaction drops ops older than a configurable number of versions
behind the newest snapshot. Details and trade-offs are in
[ADR 0004](docs/adr/0004-write-behind-persistence.md).

**The durability window, stated plainly.** Because writing is behind the edit
path, a crash can lose the most recent edits from the log: ops reach Postgres
up to 250 ms (`PERSIST_FLUSH_INTERVAL_MS`) after the edit. If another instance
also held the change, it snapshots it within `SNAPSHOT_INTERVAL_MS` (30 s) and
nothing is lost; if the dying instance was the only holder, up to roughly
250 ms of its clients' typing is gone. Tuning the flush and snapshot intervals
narrows this; nothing removes it. A graceful shutdown flushes everything. While
Postgres is unreachable, edits continue and memory is the only copy.

### Cold recovery, measured

Rebuilding one room's document from Postgres with nothing in memory and Redis
flushed (`node loadtest/recovery-bench.mjs`; Postgres 16 in Docker on the same
machine, Apple M4, Node 24, 7 runs per row with the first included):

| Scenario | Doc chars | Snapshot | Op rows | Op bytes | min ms | median ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| snapshot only | 39,382 | 89,496 B | 0 | 0 B | 2.7 | 2.8 | 4.2 |
| snapshot + 120 op rows | 44,528 | 88,471 B | 120 | 17,393 B | 2.8 | 3.1 | 3.8 |
| snapshot + 1,000 op rows | 82,825 | 91,060 B | 1,000 | 143,785 B | 8.9 | 10.7 | 12.5 |
| snapshot + 10,000 op rows | 475,072 | 89,693 B | 10,000 | 1,445,302 B | 1400.5 | 1547.0 | 1628.0 |
| no snapshot, content as ~1,000 op rows | 39,050 | 0 B | 893 | 124,255 B | 8.8 | 9.6 | 13.6 |
| no snapshot, one op row per edit | 38,909 | 0 B | 7,143 | 185,070 B | 12.6 | 13.4 | 21.5 |

With the default settings a document keeps at most a few hundred op rows
between snapshots, so a typical recovery is the first three rows: between about 3 and 11
milliseconds for a document of tens of thousands of characters. The 10,000-row
case is a stress scenario well past what retention allows, and its cost is
replaying roughly 80,000 edits into a 475,000-character document. These are
localhost figures: against a managed database add one network round trip for
the snapshot query and one for the ops query. Each scenario verifies that the
recovered state matches what was written before it is timed.

## What has been verified

All against a real Redis in a container, not mocks. Numbers below are what the
tests and runs actually produced.

- **Lost messages (Redis pub/sub is lossy by design).** Three instances, 150
  seeded random edits (about a third of them deletions), with 40% of what
  Redis delivers to each instance discarded: roughly 250-260 messages dropped
  per run. Once delivery resumes, every replica converges to identical text.
- **A lost deletion is caught.** A deletion-only update changes no state
  vector, so comparing vectors cannot see that it was missed. Reconcile
  messages therefore also carry a hash of the delete set; the test for this
  fails if that comparison is removed.
- **A real network partition.** A TCP proxy in front of one instance's Redis
  connection is severed (sockets die, reconnects fail) and later restored.
  Both sides keep accepting edits during the partition, the partitioned
  client's presence lapses for everyone else, and after the partition heals
  the documents converge and the presence returns on the next heartbeat.
- **A killed instance.** With three real processes and `kill -9` on one, a
  client of a third instance that had never hosted the room received the
  document intact, and the dead instance's client presence expired after 3.3 s
  with a 3 s TTL. (A single sanity run, not a benchmark.)
- **A socket killed mid-edit.** The client reconnects to a different instance,
  gets the same client ID back, loses no edits (including ones typed while
  disconnected), and the other side never sees two presence entries for one
  person.
- **Reconnect cost.** With a 100,001-character document (100,022 bytes of
  state), a client that dropped, typed one character offline, and reconnected
  to a different instance exchanged 159 bytes up and 157 bytes down.
- **Duplicate resumption.** Presenting one token on two instances at once
  leaves exactly one live connection. With the fence message deliberately
  discarded, the stale connection still stops itself via its heartbeat lease
  check; removing that check fails the test.

- **Each edit is logged once, by the instance that originated it.** With two
  instances and a client on each, the rows written by one instance rebuild
  exactly its client's typing and the other's exactly the other's; no instance
  logged what it received from a peer.
- **A dying originator does not lose the change if a peer holds it.** The
  originator is killed with the op still in its buffer; the op log is
  verifiably empty for that document, and the peer's snapshot alone brings the
  change back on a cold start.
- **Cold restart with Redis flushed.** After every instance stops and Redis is
  wiped, a new instance serves the document with an identical state vector.
  Three instances taking 40% message loss while snapshotting every 8 changes
  and compacting aggressively recover the converged text from Postgres alone.
- **Postgres is off the edit path.** With every database write held open,
  clients still see each other's edits immediately, and a hung database read
  does not stop a room from opening.

- **In a real browser, two windows.** Typing in one appears in the other, with a
  coloured caret and name label; a caret stayed on its character after text was
  inserted above it. With the server frozen (`SIGSTOP`: every socket stays open,
  nothing answers) and a 2 s heartbeat, the indicator changed to Offline about
  3 s later with no "reconnecting" step in between. Both windows kept accepting
  edits while offline, and 100 ms after the server resumed both reconnected,
  resumed as the **same client IDs** (the server log shows `resumed=true`), and
  merged each other's offline edits with no duplicate presence entry. A page
  reload also resumed as the same person. Hostile Markdown (`<img onerror>`,
  `<script>`, a `javascript:` link, `<style>`, `<iframe>`) was neutralised in the
  live DOM and no handler ran.
- **The integration suites drive the shipped client core**, not a test-only
  reimplementation. Deliberately breaking the core's handover of offline edits
  fails three real-infrastructure tests.

The suites that involve timing were run repeatedly with no failures: the
replication suite 20 times, the resume suites 20 times, and the persistence
suites (24 tests) 15 times.

## Running

```bash
npm install
docker compose up -d redis postgres
cp .env.example .env
# Every instance must share one resume secret (required when REDIS_URL is set):
echo "RESUME_SECRET=$(openssl rand -base64 32)" >> .env
npm run build
npm run build:web          # the browser client, served by the gateway at /
# Create the tables (reads DATABASE_URL):
DATABASE_URL=postgres://strand:strand@localhost:5432/strand npm run migrate
# several instances against one Redis, on different ports:
PORT=8081 node --env-file=.env dist/index.js &
PORT=8082 node --env-file=.env dist/index.js &
```

Without `REDIS_URL` a single instance runs standalone and generates a
throwaway resume secret. Without `DATABASE_URL` nothing is persisted. Then open
<http://localhost:8081/r/demo> in two windows. (`npm run dev:web` runs the client
under Vite with hot reload, proxying to a gateway on port 8080.)

## Tests

Integration tests run against real Redis in a container, so Docker must be
running.

```bash
npm test
```

On Docker Desktop for macOS, testcontainers may need the socket pointed at
explicitly:

```bash
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## Limitations

These are known and deliberate, not oversights.

- **Redis outage weakens identity uniqueness.** One live connection per client
  ID is enforced against a lease in Redis. While Redis is unreachable, that
  check can only see connections on the same instance, so the same resume
  token presented on two different instances can be admitted twice until Redis
  returns and the heartbeat lease check fences one of them. I chose to degrade
  uniqueness rather than refuse connections: refusing to let people connect
  because the coordination layer is down turns a partial outage into a total
  one. The cost is a brief period of two tabs acting as one person (their
  edits merge harmlessly; a stale cursor can linger for about one heartbeat).
- **Durability window.** Write-behind persistence can lose the most recent
  ~250 ms of edits when the only instance holding them crashes (see
  Persistence above), and edits made during a Postgres outage exist only in
  memory until it returns.
- **Rooms are memory-bound per instance.** A room's document is held whole in
  memory on every instance hosting it, and a snapshot rewrites it whole. There
  is no paging, and no limit on document size beyond the inbound message cap.
- **No authentication and no per-document access control.** Anyone who can
  reach the service and knows a room ID can read and edit that room's
  document. Resume tokens are not revocable and grant nothing beyond reclaiming
  a client ID; this is only acceptable because there is nothing to protect
  (ADR 0003).
- **The op log and document history grow.** Compaction bounds the log, but a
  document's CRDT history only grows as it is edited, documents are never
  deleted, and every snapshot stores the whole document.
- **Offline edits live in the page's memory.** They survive going offline and
  reconnecting, but not closing or reloading the tab while offline: the local
  document is not saved to IndexedDB.
- **Offline detection takes about 1.5 heartbeat intervals.** With the default
  15 s heartbeat the indicator says Offline after roughly 24 s of silence. A
  shorter `HEARTBEAT_INTERVAL_MS` makes it faster at the cost of more traffic.
- **The client bundle is large**: about 921 KB (306 KB gzipped), mostly
  CodeMirror, Markdown, and the sanitiser, in a single chunk with no code
  splitting.
- **Scroll sync is proportional**, not tied to source lines, so it drifts on
  documents whose rendered height differs a lot from their source height.
- **Windows of one browser share a saved display name and colour** (they are
  stored per browser, not per tab), so two of your own windows look like the same
  person until one is renamed.

- **Compaction safety is a timing assumption, not a proof.** It relies on
  instances holding a change snapshotting within a bounded time; the narrow
  conditions under which a change could be lost are in ADR 0004.

## License

MIT
