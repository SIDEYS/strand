# ADR 0002: Redis pub/sub with periodic state-vector reconciliation for cross-instance fan-out

## Context

Any instance can host any room, with no sticky sessions, so two clients in
the same room are routinely connected to different instances. Every edit
and presence change on one instance has to reach the others.

Redis pub/sub is the obvious transport and has one property that decides
the design: it is fire-and-forget. A subscriber that is briefly
disconnected, or too slow and hits its client-output-buffer-limit, silently
misses messages. A naive design built on it permits permanent divergence
between two instances, and it looks fine in every local test, because
loopback Redis never drops anything.

The decision is therefore less "which transport" than "what makes the
system correct when the transport loses messages."

## Options considered

**(a) Redis Streams.** Replayable, with explicit cursors. Considered
seriously because it removes the lossy hop outright.

- Consumer *groups* are the wrong tool: they deliver each message to one
  consumer in the group, which is work distribution. Fan-out needs every
  instance to see every message, so this would be one stream per room with
  each instance tracking its own cursor via `XREAD`. That discards most of
  what makes groups attractive (acknowledgement, redelivery).
- Streams are retained up to a `MAXLEN`. An instance that is down longer
  than the retention window cannot replay its gap. It would still need a
  state-vector sync to catch up, so Streams does not remove the
  reconciliation mechanism; it only narrows when it is needed.
- Operationally heavier: one blocking `XREAD` has to cover every room an
  instance hosts, and the key set changes as rooms come and go (each change
  interrupts the blocked read); every update is also held in Redis memory.

**(b) Pub/sub for latency, plus periodic state-vector reconciliation.** The
option taken.

**(c) Both.** Streams for the common-case replay, reconciliation as the
backstop. Strictly more machinery than (b), for a tighter divergence window
that this product (collaborative text, not payments) does not need.

## Decision

(b). Which mechanism is load-bearing matters, so to be explicit:

- **Pub/sub is the optimisation.** It makes the common case take a
  millisecond. Nothing is allowed to depend on it.
- **Reconciliation is the correctness mechanism.** Every
  `RECONCILE_INTERVAL_MS` (default 5s, jittered ±20%), each instance
  publishes, per hosted room, its Yjs state vector and a digest of its
  delete set. A peer that finds it differs replies, addressed to the
  sender only, with `encodeStateAsUpdate(doc, theirStateVector)`: exactly
  what they lack. Yjs updates are commutative and idempotent, so a diff
  that arrives twice, late, or out of order is harmless. Divergence from
  any number of lost messages therefore heals within about one interval of
  the network being healthy.

This is only possible because the replicated state is a CRDT. With state
that required ordered application, (a) would be the right answer.

### The delete-set blind spot

A state vector summarises which *structs* a replica has. Deleting text
creates no structs, so a replica that missed a deletion-only update (a
backspace) has a state vector identical to one that received it. Comparing
vectors alone would leave it showing deleted text forever. The reconcile
message therefore also carries a 16-byte digest of the delete set
(encoded sorted and merged, so converged replicas hash identically), and a
reply is sent when either differs. There is a test for exactly this case,
and it fails if the digest comparison is removed.

### Loop prevention is explicit

Redis delivers a publisher's own messages back to it, because the
publishing instance is subscribed to the channel it publishes on. Every
envelope carries its origin instance ID and every subscriber drops
`origin === self`. A second, independent guard: updates applied from a peer
carry a `REMOTE_ORIGIN` transaction marker, so the doc's update handler
delivers them to local clients but does not publish them again.

One thing worth knowing about the tests: because Yjs applies are
idempotent, an echoed message would be absorbed harmlessly even without the
origin check, so "one edit causes one publish" does not by itself prove the
check works. A separate test forges a message claiming the receiver as its
origin and asserts it is ignored.

### Local apply, then publish

A client's edit is applied to the local doc and fanned out to local clients
before the publish is attempted, so users see their own and their
neighbours' edits at local latency. Publishing is fire-and-forget; its
failure is logged and left for reconciliation.

### Joining a room on a cold instance

A room exists on an instance only while it has local members. A client
joining an instance that has never hosted the room must not be shown a
blank document that peers have content for. On room creation the instance
publishes a reconcile marked as a join and learns from the `PUBLISH`
return value how many subscribers it reached. Our own subscription counts
as one, so anything more is a peer that will answer. It waits for that many
replies, bounded by `JOIN_SYNC_TIMEOUT_MS` (500ms), and otherwise serves
what it has. Reconciliation repairs whatever the timeout cut short. A lone
instance sees a count of one and does not wait at all.

### Presence

Presence uses the same shape, with a different repair path.

- Each entry is stored in Redis (a sorted set of deadlines plus a hash of
  entries per room, manipulated by Lua scripts) and refreshed on every
  heartbeat pong. **Redis's `TIME` decides expiry**, so instances cannot
  disagree about whether a client is alive, and an instance that dies
  ungracefully has its clients' presence disappear within one TTL, without
  anyone having to notice it died.
- Keyspace expiry notifications were rejected as the removal signal: they
  are delivered over pub/sub and would reintroduce the exact lossiness this
  ADR is about. Instead each instance periodically lists the store and
  repairs its local set.
- A remote entry that has vanished from the store is removed locally with
  **the timestamp last seen for it, captured before reading the store**. A
  remove stamped at the observed add timestamp beats exactly that add
  (remove wins ties, ADR 0001) and nothing newer, so an update racing the
  sync survives instead of being clobbered.
- A refresh re-stamps the entry with a newer timestamp. That is what makes
  the system self-healing in the one direction it needs to be: if Redis
  loses state or a peer wrongly synthesised a removal, the owner's next
  heartbeat re-adds the entry with a timestamp that beats it.

### Cross-instance clock skew

ADR 0001 requires server-stamped timestamps and promised this ADR would say
how skew between instances is bounded. Each instance stamps with a hybrid
logical clock: wall time, but never at or below anything it has stamped or
observed. Once an instance has seen another's op, everything it stamps
afterwards sorts after it regardless of skew, which covers the case that
matters (a client reconnecting from one instance to another). Skew between
instances that never observe each other is not eliminated; it is bounded
by presence being self-healing. Observations further than 60s ahead of the
local wall clock are ignored, so one instance with a badly wrong clock
cannot drag the rest into the future. Instances are trusted; this guards
against misconfiguration, not an attacker.

## Consequences

**The divergence window is bounded by the reconcile interval, not by
round-trip time.** After a lost message, a lagging instance (and its
clients) may show stale content for up to one interval (about 5s by
default) once the network is healthy. A Streams design would shrink that to
roughly a round trip for short disconnects. Under *continuous* loss there is
no bound at all; the guarantee is about recovery, not about performance
during an outage. Lowering the interval trades Redis traffic for a tighter
window.

**Reconcile traffic scales with rooms and instances.** Per hosted room, per
interval: one state vector out per instance, and a diff back from each
peer that has something. State vectors grow with the number of distinct
Yjs client IDs that ever edited the document (one per browser session), so
long-lived, heavily-shared documents have larger vectors. The delete-set
digest is recomputed on each send and receive, in time proportional to the
delete set; it is uncached today.

**A cold room has no durable source.** Room state lives in instance memory
and in the peers' memory. If every instance hosting a room drops it, the
content is gone. Phase 5 (persistence) closes this; until then fan-out is
purely a mechanism for keeping live replicas consistent, not for durability.

**Redis outage.** Publishes fail fast instead of queueing (an offline
queue would replay a stale-update storm on reconnect), so edits keep
working locally and instances drift apart. They converge within an interval
of Redis returning. Presence entries cannot be refreshed during the outage,
so for an outage longer than the presence TTL (or a Redis that restarts
empty) peers will briefly drop live remote clients' presence, and each
reappears on its owner's next heartbeat. That flicker is the accepted cost
of making expiry authoritative in Redis.

**Instance death.** Its clients' presence expires within one TTL plus one
sync tick. Its documents are unaffected: every other instance hosting the
room has the full state.

**Network partition between instances** is, from this design's point of
view, indistinguishable from messages being lost for a while, and is
handled the same way: both sides keep accepting edits, and reconcile after
the partition heals. Because the document is a CRDT, no edit is lost and no
side has to win.
