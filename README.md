# Strand

[![CI](https://github.com/SIDEYS/strand/actions/workflows/ci.yml/badge.svg)](https://github.com/SIDEYS/strand/actions/workflows/ci.yml)

A realtime collaborative Markdown editor built to run as several stateless
server instances behind a load balancer, with no sticky sessions. Multiple
people edit one document at once and see each other's cursors live.

Work in progress; the final write-up (architecture diagram, interesting
problems) arrives with the last phase. Benchmarks and operations are below.

## Quickstart

```bash
docker compose up --build
```

That starts Postgres, Redis, a one-shot migration, **three** Strand instances,
and nginx in front of them. Open <http://localhost:8080/r/demo> in two browser
windows. nginx does plain round-robin, so the windows usually land on different
instances (each WebSocket upgrade response carries an `X-Strand-Instance`
header, visible in the browser's network tab). Edit in one and watch the
other; the instances are also reachable directly on ports 8081 to 8083.

To check the cluster from the command line instead:

```bash
npm install && npm run build
node loadtest/smoke.mjs        # two clients on different instances, edits cross both ways
```

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

## Operating it

### Health, readiness, metrics

| Endpoint | Answers | Fails when | Wire it to |
|---|---|---|---|
| `/healthz` | "the process is alive" | the process cannot answer at all | restart |
| `/readyz` | "send me new connections" | Redis or Postgres is unreachable (503) | routing |
| `/metrics` | Prometheus text, one registry per instance | n/a | scraping, privately |

The distinction matters. `/healthz` never looks at dependencies: if it did, a
Redis outage would make an orchestrator restart every instance and drop every
collaborator's socket. `/readyz` does look, with each probe time-bounded and
cached for a second; on failure the instance answers 503 so a balancer stops
sending it *new* connections, while it keeps serving the sockets it has. This
is tested against a really severed Redis (`src/api/readiness.int.test.ts`):
the process stays up, two clients on one instance keep editing together, and
readiness recovers by itself. Reasoning and the measured costs are in
[ADR 0006](docs/adr/0006-liveness-readiness-and-plain-round-robin.md).

`/metrics` is unauthenticated and nginx returns 404 for it; scrape the
instances directly. Metrics (all carry an `instance` label), besides the
default Node.js process metrics:

| Metric | Type | Meaning |
|---|---|---|
| `strand_connected_sockets` | gauge | open client connections |
| `strand_rooms_in_memory` | gauge | rooms held by this instance |
| `strand_doc_updates_total{origin}` | counter | edits applied, `local` or `remote` (updates/sec is its rate) |
| `strand_handshakes_total{result}` | counter | `new`, `resumed` (reconnects), `token_rejected` |
| `strand_disconnects_total{reason}` | counter | why connections ended |
| `strand_backpressure_disconnects_total` | counter | slow consumers cut off |
| `strand_fanout_publish_seconds` | histogram | time to publish to Redis |
| `strand_fanout_receive_seconds` | histogram | publisher timestamp to receipt (instances share a clock only on one host) |
| `strand_snapshot_duration_seconds` | histogram | time to write a snapshot |
| `strand_snapshot_conflicts_total`, `strand_persist_*` | counters | persistence health |

### The image

A multi-stage build (`Dockerfile`) ends in a plain Alpine image holding only
the Node binary, production dependencies and the compiled code and client:
**188 MB** for the container's filesystem and **58.4 MB** compressed (what a
pull transfers), runs as a non-root user, with a health check on `/healthz`.
`docker images` on the machine I built it on reports 258 MB for the same image;
I give all three because they measure different things and I did not chase down
the difference.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs lint, type checks, unit tests, the
integration tests (against real Redis and Postgres through testcontainers), both
builds, then brings up the whole compose stack and runs the smoke test against
it, and finally builds the image and pushes it to GHCR on pushes to `main`.

### Deploying

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has the commands for three instances
behind a load balancer with managed Redis and Postgres (Fly.io), and lists what
could not be verified without running them.

## Running without Docker for the app

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

## Benchmarks

**Read this first.** Everything below was measured on one laptop (Apple M4,
Docker Desktop with 10 CPUs and 7.7 GiB for the whole stack), where the load
generator, three Strand instances, nginx, Redis and Postgres all compete for the
same cores, and where the person using it may be running other things. That is
good enough to show behaviour and bad for finding a ceiling. The tooling now
records what else the machine is doing and refuses to benchmark a busy one
(`loadtest/run.mjs`), but the runs in the tables below predate that, so treat
them as measurements of this setup, not of Strand's limits. Every figure comes
from a recorded run; nothing is estimated. Raw results are not committed
(`loadtest/results/` is gitignored); the commands to regenerate them are at the
end of this section.

**Configuration.** `docker compose up` stack: 3 Strand instances (Node 22,
default settings: heartbeat 15 s, reconcile 5 s), nginx 1.27 round-robin,
Redis 7, Postgres 16. Load from k6 v2.3.0 in Docker on the same network: 500
users in 100 rooms of 5, ramped in over 60 s then held 120 s, each user typing
about one small edit per second (±50%) and sending presence every ~5 s, so
about 500 edits/s in and about 2,000 deliveries/s out. Users are placed on
instances round-robin, so about 80% of sender/receiver pairs are on different
instances.

### Edit propagation at 500 sockets

Time from a user generating an edit to another user receiving it, on one clock
(the generator is one process), live deliveries only. The clock is
`Date.now()`: whole milliseconds, so "0" or "1" means about a millisecond or
less.

| run | pairs | deliveries | p50 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|
| A (cold stack) | same instance | 59,827 | 0 | 1 | 11 | 149 | 516 |
| | different instance | 239,290 | 1 | 2 | 19 | 180 | 548 |
| B | same instance | 59,847 | 0 | 1 | 9 | 87 | 171 |
| | different instance | 239,329 | 1 | 2 | 17 | 113 | 191 |
| C | same instance | 59,931 | 0 | 1 | 2 | 5 | 21 |
| | different instance | 239,856 | 1 | 1 | 3 | 7 | 27 |
| via nginx | all pairs | 299,166 | 1 | 1 | 3 | 19 | 83 |

- **The median and p95 are stable; the tails are not.** The three identical
  direct runs differ by up to 6x at p99. Run A includes one interval where every
  container on the host stalled at once (all three instances reported 224 to
  275 ms of event-loop lag in the same sample), which is the host, not any one
  component. Run A also used an earlier version of the generator (the older k6
  WebSocket API). I report all of them instead of the best.
- **Same-instance and different-instance are close.** The same-instance path
  skips the Redis hop but both are dominated by the same event loop work. The
  servers' own measurement of the hop (publisher timestamp to receipt, every
  envelope, run B): p50 0.32 ms, p95 0.92 ms, p99 4.3 ms. That one has
  sub-millisecond resolution; the table above does not.
- **nginx added nothing visible.** Through the balancer the tails were not
  worse than direct (they were better in the one run I did, which is within the
  run-to-run spread, so I make no claim that it helps).
- No backpressure disconnects, no dropped log operations, no flush failures; the
  busiest instance used 12 to 31% of one core outside stalls, and all
  containers together used 13 to 19% of the machine.
- **No edit was lost or duplicated** in any of these runs. After each run,
  `loadtest/verify.mjs` reads every room back through the real client core and
  checks every user's edits are contiguous with none missing, and that the
  total equals what the generator produced. I checked the checker: it fails a
  room with an edit removed, and a wrong expected total.

### Killing an instance mid-test

500 users through nginx; once all were connected and 20 s had passed, one
instance (holding 166 of 502 sockets) was killed with SIGKILL.

| | |
|---|---|
| connections dropped / reconnected and synced again | 166 / 166 |
| each client's outage, loss to synced: p50 / p95 / p99 / max | 437 / 2,470 / 2,497 / 2,501 ms |
| edits produced / lost | 89,796 / 0 |

The median is mostly the web client's own reconnect backoff (250 to 500 ms
before the first retry), which the generator reproduces. The 2.5 s tail is
nginx: attempts routed to the dead instance before nginx marked it down waited
out `proxy_connect_timeout 2s` (nginx logged `upstream timed out while
connecting`). SIGKILL is the kindest failure: clients get a reset immediately.

### Freezing an instance (the harder failure)

Same load, but the instance is paused (`docker pause`): its sockets stay open
and silent, with no reset. This is what a hung process or a partition looks
like.

| | |
|---|---|
| connections lost / recovered | 166 / 166 |
| each client's outage: p50 / p95 / p99 / max | 24,574 / 43,101 / 59,578 / 71,165 ms |
| handshake timeouts during recovery | 82 |
| edits produced / lost | 89,102 / 0 |

Clients notice by silence after 1.5 heartbeats plus a second (about 23.5 s),
which is the median. The tail is worse: nginx's passive checks never mark a
node that accepts connections but never answers as failed, so about one in three
reconnect attempts lands on the frozen node and hangs until the client's own 8 s
handshake timeout. The maximum is bounded by when I unfroze the instance at 70 s.
A balancer with active health checks (probing `/readyz`) removes the hung node
and would cut that tail ([ADR 0006](docs/adr/0006-liveness-readiness-and-plain-round-robin.md)).
No edits were lost.

### Memory per room

A "room replica" is a room held by one instance, which is what
`strand_rooms_in_memory` counts (a room with members on all three instances is
three replicas).

- **Rooms of one idle-ish user** (3,000 rooms, ramped over 300 s, one small edit
  per 10 s): resident memory rose 172 MiB above the 234 MiB idle baseline, **58.7
  KiB per replica averaged, but not linear**: by thirds of the ramp the marginal
  cost was 146, then 35, then **12.5 KiB** per replica (heap alone: 41.7, 8.7,
  5.4 KiB). The early rooms pay for process warm-up; what a new room costs once a
  process is warm is the last figure, and it includes one socket's buffers.
- **Rooms of five typing users** (the 500-socket runs, 300 replicas, each
  holding about 22 KB of text by the end: 150 edits of ~29 bytes from each of 5
  users, computed rather than measured): 64 to 108 MiB above baseline in the two
  runs I measured this in, or **220 to 370 KiB per replica**. Content dominates:
  each edit is a CRDT item with its own bookkeeping, so a busy room costs far more
  than an empty one, and the fit was noisy (R² 0.76 to 0.86) because resident
  memory follows garbage collection, not allocation.

### Where it degrades

I could not establish Strand's own ceiling on this machine, and I would rather
say so than quote a number. I pushed four times (4,000 users in rooms of five
with the generator uncapped, then capped to 5 cores; 1,500 users; 3,000 users in
rooms of two). Every time, latency blew out somewhere between roughly 700 and
1,650 sockets (700 to 1,550 edits/s), and every time the load generator or the
host was saturated at the same moment: k6 at 500 to 650% of the machine's 1,000%,
its own timers firing seconds late, the whole host at 95% or more, and the user's
other applications competing (load average up to 25). The last attempt was
discarded entirely: the machine stalled (the sampler's clock jumped by over an
hour). So the honest statements are:

- **Healthy to at least 500 sockets / 500 edits/s** with large headroom (busiest
  instance at 12 to 31% of a core, whole host at 13 to 19%).
- **What the failure looks like once it starts** (observed, though not
  attributable to Strand alone): propagation percentiles go from milliseconds to
  seconds to tens of seconds; clients too slow to answer pings are evicted for
  `heartbeat_timeout` (227 to 7,388 times); they reconnect with their resume
  token in a storm (187 to 7,464 resumed handshakes) and recover by resuming;
  snapshot duration p99 climbs from a few ms to 1.7 and 4.8 s in the two runs
  that got that far; persistence flush failures appeared in one (29) while no log
  operation was ever dropped; each instance sat at 60 to 90% of a core with event-loop lag p99 of
  60 to 160 ms. **Backpressure disconnects stayed at zero in every run**, so
  that protection is untested at scale here.
- **Integrity under overload is not established.** After the 4,000-user run, 5 of
  288,330 edits (and 385 of 110,431 after the capped one) were absent. None were
  inside a user's sequence (each was the tail of one), which fits a generator
  that hung up with edits unsent or unprocessed while it was minutes behind, but I
  did not prove that and it could also be a server loss. Every run at 500
  sockets or fewer, and the 3,000-room run, passed the same check with zero
  missing.
- **A caution about my own tool.** Two later 500-socket runs on a visibly busy
  machine (a game using ~100% of a core, Chrome using more) were far worse than
  the earlier ones (p95 229 to 309 ms) with k6 reporting ~565% CPU. That was
  after I made the generator cheaper, so either the contention or the new
  generator revision is responsible, and I did not separate them. A re-run on a
  quiet machine settles it; if k6 is still near 565% for 500 users, the generator
  is at fault and needs fixing.

To get a real ceiling, run the generator on a different machine from the
system under test, or at least close everything else and use the commands below.

### Reproducing

```bash
docker compose up -d --build --wait
npm run build
bash loadtest/suite.sh                  # ~35 min: steady x2, via nginx, kill, freeze, rooms
node loadtest/run.mjs breaking --vus 4000 --ramp 360 --hold 60 --drain 150   # push until it breaks
node loadtest/report.mjs loadtest/results/<run>
```

Scenarios live in `loadtest/` (`collab.k6.js` is the k6 script, run in the
`grafana/k6` image so nothing is installed locally; `run.mjs` orchestrates and
samples; `verify.mjs` checks integrity; `report.mjs` writes the tables). The
report opens with a banner if the host was contended or the generator's own timers
ran late, and it will not be silent about either.

## Tests

Integration tests run against real Redis and Postgres in containers, so Docker
must be running for those.

```bash
npm run test:unit          # no Docker needed
npm run test:integration   # real Redis and Postgres via testcontainers
npm test                   # both
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

- **Strand's own ceiling is not measured.** See Benchmarks: on one shared laptop
  the load generator or the host saturated first. Also unmeasured: a
  multi-region setup, and Strand against Upstash Redis or any managed Redis
  (the Lua scripts use `TIME`; see docs/DEPLOYMENT.md).
- **Failure detection is the balancer's job, and nginx's is weak.** Open source
  nginx only learns an instance is dead from failed connections, so a hung (not
  dead) instance keeps receiving about a third of new connections until clients
  time out. Use a balancer with active health checks against `/readyz` in
  production (ADR 0006).
- **`/readyz` fails fleet-wide when shared infrastructure fails.** Every
  instance reports not-ready during a Redis outage, so a balancer that honours
  it has nowhere to send new connections, though existing sockets keep working.
- **Compaction safety is a timing assumption, not a proof.** It relies on
  instances holding a change snapshotting within a bounded time; the narrow
  conditions under which a change could be lost are in ADR 0004.

## License

MIT
