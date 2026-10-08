# ADR 0003: Stateless resume tokens, with identity uniqueness enforced by a Redis lease

## Context

A client that loses its connection should come back as the same person, not
as a new user: same client ID, presence continuing rather than duplicated.
It may reconnect to any instance, so whatever proves "this was me" has to
work on instances that have never seen the client.

Phase 1 settled that a client never asserts its own ID, because two tabs
claiming one identity make presence incoherent. A reconnecting client wants
exactly that, to claim an ID it held before, so the server needs a way to
hand it back that is not "believe the client."

## Options considered

**Server-side sessions in Redis.** Store `token -> clientId` and look it up.
Every instance can honour it, and it can be revoked instantly. It also adds
a Redis read to every connect, makes resume depend on Redis being up, and
spends a stateful mechanism on a threat this service does not have (below).

**Stateless signed token.** The server signs the claim `{clientId, roomId,
issuedAt, expiresAt}` and any instance holding the shared secret can verify
it with no lookup. This is the option taken.

**JWT.** Rejected for the library, not the idea. The format carries an
`alg` header that a verifier is tempted to honour; the classic failures
(`alg: none`, RS256/HS256 key confusion) all come from accepting the
algorithm from the token. Here there is one algorithm, fixed in code, and
four fields. A JWT library would bring the footgun without the benefit.

## Decision

### The token

`payload || HMAC-SHA256(secret, DOMAIN || payload)`, where the payload is
`[format][clientId][roomId][issuedAt][expiresAt]`. The MAC covers the exact
bytes received, so there is no re-serialisation step to hide a
canonicalisation bug. The domain prefix means a signature made for any
other purpose with the same secret can never be replayed as a resume token.
Verification checks, in order: structure, then expiry, then the MAC with
`timingSafeEqual`, then that the room matches. Expiry goes first only
because it is cheap and the common failure; the unauthenticated claims are
used for nothing but rejecting, and a forged "unexpired" value fails the MAC.

An invalid token (expired, forged, wrong room, garbage) is not an error. The
client becomes a new user and joins. A client whose token lapsed during a
long outage should be a new user, and treating rejection as a disconnect
would only turn an ordinary expiry into a failure.

The token is issued at WELCOME and re-sent when it is half-way to expiry, so
a connection that stays up for hours still holds a valid one. Lifetime
defaults to 5 minutes: it only has to outlast a reconnect.

`RESUME_SECRET` must be identical on every instance. Startup refuses to run
with `REDIS_URL` set and no secret, because a per-process random secret
would make each instance reject the others' tokens, which surfaces only as
resumes quietly failing once a load balancer moves a client. Rotating the
secret invalidates outstanding tokens; affected clients rejoin as new users.

### Why no revocation

Revocation matters when a token grants privilege. This one does not. There is
no authentication in the system, so the worst a stolen token allows is
claiming a client ID in a room the thief could already join anonymously.
That is why server-side session state is the wrong trade: it solves a threat
that does not exist here, at a real cost in availability and complexity.

**This inverts the moment the service gains real auth.** A token that
grants access to a document is a credential, a stolen credential must be
revocable, and a stateless token cannot be revoked before it expires. At
that point resume state belongs in Redis (or the token must be short enough
to treat expiry as revocation, with the cost of re-authenticating more
often). The decision above is conditional on there being nothing to
protect; it should be revisited together with the first access control.

### Uniqueness is enforced against shared state, not by the token

Statelessness has a gap: a token can be presented twice. Two tabs restored
after a crash, or a replay, then both claim one client ID, which is the
Phase 1 problem returning through the back door. The token cannot prevent
this because it carries no memory of use.

So the token is stateless but identity uniqueness is enforced against
shared, live state: a Redis **session lease** per `(room, clientId)`, holding
the owning connection and a deadline measured by Redis's own clock. The
rule is *newest wins, and the older connection is fenced*:

1. A resume fences any other local connection holding the ID, then claims
   the lease. If the claim displaces a live owner on another instance, a
   fence message is sent to that instance.
2. The older connection is closed with `Superseded` (4006). It is inert from
   that moment: input ignored, and its eventual departure leaves presence
   and the room slot alone, because the person is still here on the newer
   connection.

Fencing is preferred over issuing a fresh ID to the second connection
because it matches what people expect on reopening a tab and keeps presence
continuous. It reuses the same mechanism presence already uses (a deadline
refreshed on heartbeat, owned by Redis's clock).

**Which part is load-bearing.** The fence message travels over pub/sub,
which drops messages, so it is only the fast path. The guarantee comes from
the heartbeat: on every pong a connection calls `touch`, which refreshes the
lease if the connection still owns it and reports failure if a different
live owner holds it. A fenced connection whose message was lost therefore
stops itself within one heartbeat interval. No lock or lease is treated as
absolute mutual exclusion, since a holder can lose it without noticing; what
bounds the overlap is that every holder keeps re-checking. A test discards
the fence message and removes the heartbeat check to confirm the check is
what stops the stale connection.

The `touch` operation fails open: if Redis is unreachable, or the lease has
simply vanished (a flush, a failover), the connection keeps its identity and
re-takes the lease. Only a different, live owner fences. An outage must not
disconnect people who are connected.

**Why a lease and not presence entries.** The obvious signal for "this ID
is already connected" is a presence entry. It is unreliable for that job: an
entry exists only after a client's first cursor update, so a connected
client that has not sent one would look absent and its identity could be
taken. The lease is written at connect. It borrows the presence design
rather than its data.

### `Superseded` is not retried

Of the close codes, `Superseded` is deliberately in the "do not auto-retry"
class. If a superseded tab reconnected on its own it would evict the tab that
replaced it, which would reconnect and evict it back, indefinitely. The
client stops, reports `superseded`, and leaves taking the session back to the
user (a manual reconnect does fence the other tab, as intended). The same
class holds protocol-version mismatch and malformed or oversized messages:
the same request fails the same way each time, so retrying is a
self-inflicted denial of service. The policy is pure functions in
`protocol/reconnect.ts`, shared with the browser client, and tested without
timers.

### Presence across a resume

- If the old connection was **fenced**, its presence entry never went away
  and the new connection inherits it. The resuming instance reloads the entry
  from Redis and re-stamps it so it wins over any removal a peer synthesised
  meanwhile.
- If the old connection **departed cleanly or timed out first**, its presence
  was removed, and the client re-announces on every connect. The reconnect
  client does this unconditionally, so a returning user reappears without
  waiting on any server state.

Either way there is one entry per person, keyed by the client ID, which is
what rules out duplicates.

### Resync is a state-vector exchange

After answering a client's `SyncStep1` with `SyncStep2`, the server sends its
own state vector. The client replies with only what the server lacks. The
server also withholds document updates from a client until its `SyncStep1`
has been answered, because that diff is computed afterwards and already
covers them. (Without this, a client reconnecting to a cold instance was
sent the whole document a second time, as the updates that instance applied
while rebuilding the room from a peer. This was found by measuring.)

## Consequences

- Reconnecting costs what was missed, not the size of the document, with one
  caveat: Yjs sends the document's entire delete set with every diff, so
  that portion scales with the number of deletions, not with what was
  missed. It is compact (ranges), but it is not zero.
- A fenced connection can act as the client for up to one heartbeat interval
  after losing the lease. Edits it makes in that window are CRDT updates and
  merge harmlessly; presence from it would be a stale cursor for at most that
  long.
- While Redis is unreachable, identity uniqueness holds only among
  connections on the same instance. Two tabs resuming on different instances
  can both be admitted until Redis returns and the heartbeat check fences
  one. The alternative, refusing to connect people while the coordination
  layer is down, turns a partial outage into a total one.
- Tokens are not bound to a device or network. Anyone holding one can resume
  that client ID until it expires. Acceptable only because of the no-auth
  premise above.
- The shared secret is a deployment dependency with no rotation scheme beyond
  "everyone rejoins as a new user."
