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

## Running

```bash
npm install
docker compose up -d redis postgres
cp .env.example .env
npm run build
# several instances against one Redis, on different ports:
PORT=8081 node --env-file=.env dist/index.js &
PORT=8082 node --env-file=.env dist/index.js &
```

Without `REDIS_URL` a single instance runs standalone.

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
