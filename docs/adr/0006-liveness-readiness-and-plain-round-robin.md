# ADR 0006: Liveness and readiness are different questions; the load balancer is plain round-robin

## Context

Running several instances behind a load balancer raises two operational
questions that look like one. "Is this process broken?" decides whether to
restart it. "Should this instance receive new connections?" decides whether to
route to it. A single health endpoint answers both and gets one of them wrong.

## Decisions

**`/healthz` is liveness only.** It returns 200 if the process can answer, and
checks nothing else. If it fails, restarting the process is the right response.
It must not depend on Redis or Postgres: a dependency outage that made every
instance fail liveness would have the platform restart the whole fleet, which
turns an outage into a bigger one and drops every collaborator's socket for no
benefit.

**`/readyz` is readiness.** It probes Redis (`PING`) and Postgres (`SELECT 1`),
each under a timeout, results cached for a second and shared by concurrent
callers, and returns 503 when either is down. A 503 means "route new
connections elsewhere", not "restart me". The instance keeps serving its
existing sockets: two collaborators on the same instance keep editing together
during a Redis outage, and cross-instance sync catches up by reconciliation when
Redis returns (ADR 0002). This was verified against a really severed Redis, not
a mock (`src/api/readiness.int.test.ts`), including that the process does not
exit and that readiness recovers by itself.

The cost of that design is that when *shared* infrastructure fails, every
instance reports not-ready at once and a balancer that honours it has nowhere
to send new connections. That is the correct signal (new connections would
land on instances that cannot sync them), but it is a fleet-wide refusal rather
than a graceful degradation, and operators should know it.

**The load balancer does plain round-robin and the config says so.** Nothing in
Strand depends on a client reaching the same instance twice: rooms are
replicated by fan-out (ADR 0002), sessions are resumable anywhere (ADR 0003),
documents live in Postgres (ADR 0004). Sticky sessions would not be a harmless
extra. They would hide exactly the bugs this architecture exists to rule out
(a missing cross-instance path works fine when both collaborators happen to be
pinned together). `deploy/nginx.conf` therefore has no `ip_hash` or
equivalent, with a comment that this is deliberate, and `zone strand 64k` so
that round-robin state is shared between nginx worker processes (without it each
worker round-robins independently and traffic clusters on the first instance,
which we measured).

`proxy_read_timeout` is 3600 s, far above the 15 s heartbeat, because nginx's
60 s default would cut healthy-but-quiet sockets. That choice has a measured
cost, below.

**`/metrics` is not exposed through the balancer** (it returns 404 there) and is
not authenticated; scrape instances directly on a private network.

## Consequences, including the ones we measured

- A killed instance (SIGKILL) is detected immediately by its clients (the
  connection resets) and its clients are reconnected elsewhere in about half a
  second at the median. The tail, about 2.5 s, is nginx's passive failure
  detection: attempts routed to the dead instance before nginx marks it down
  wait out `proxy_connect_timeout 2s` (nginx logged `upstream timed out ...
  while connecting` for those).
- A *frozen* instance (process stopped, sockets open, no reset) is worse and is
  the failure that passive checks cannot see. Clients notice by silence after
  1.5 heartbeats plus a second, about 23.5 s; and since nginx's passive checks
  never mark a node that accepts TCP connections but never answers as failed,
  and `proxy_read_timeout` is long, roughly every third reconnect attempt
  during the freeze hangs until the client's own 8 s handshake timeout. Measured
  outage: median about 25 s, p95 43 s, worst 71 s (the freeze lasted 70 s). No
  edit was lost. A balancer with active health checks (HAProxy, a cloud load
  balancer, nginx Plus) removes the hung node from rotation and would cut the
  tail to roughly the detection time; `/readyz` is the endpoint to probe.
- An orchestrator should restart on `/healthz` and route on `/readyz`; wiring
  them the other way round is the mistake this ADR exists to prevent.
