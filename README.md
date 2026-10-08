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

The suites that involve timing were run repeatedly: the replication suite 20
times and the resume suites 20 times with no failures.

## Running

```bash
npm install
docker compose up -d redis postgres
cp .env.example .env
# Every instance must share one resume secret (required when REDIS_URL is set):
echo "RESUME_SECRET=$(openssl rand -base64 32)" >> .env
npm run build
# several instances against one Redis, on different ports:
PORT=8081 node --env-file=.env dist/index.js &
PORT=8082 node --env-file=.env dist/index.js &
```

Without `REDIS_URL` a single instance runs standalone and generates a
throwaway resume secret.

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

## License

MIT
