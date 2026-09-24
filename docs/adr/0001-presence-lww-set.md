# ADR 0001: Yjs for document text, a hand-rolled LWW-element-set for presence

## Context

Strand needs two different kinds of shared, concurrently-edited state per room:

1. **Document text** — the Markdown source. Needs real merge semantics:
   concurrent inserts/deletes at nearby positions must combine sensibly,
   not last-writer-clobbers-everything.
2. **Presence** — each collaborator's cursor position, selection range,
   display name, and colour. Structurally much simpler: it's a map from
   `clientId` to "this client's current presence value," where the only
   operations are "set my value" and "I'm gone." There's no need to merge
   two different cursor positions into a blended cursor position — one of
   them is simply the current one.

Both need to converge correctly when applied out of order or with
duplicate delivery, since Phase 3's fan-out (Redis pub/sub or Streams) does
not guarantee in-order, exactly-once delivery across instances.

## Options considered

- **Yjs for both.** Yjs ships a `Y.Map` which could hold presence, and
  `y-protocols/awareness` is the standard companion library for exactly
  this use case.
- **Operational transform for text.** Rejected outright — OT needs a
  central sequencing authority to resolve conflicts, which is precisely
  the single point of coordination a horizontally-scaled, no-sticky-
  sessions design is trying to avoid. A CRDT doesn't need one: any two
  replicas that have seen the same set of updates converge, regardless of
  which instance applied them or in what order.
- **Yjs for text, hand-rolled LWW-element-set for presence.** The option
  taken.

## Decision

Yjs (`Y.Doc` / `Y.Text`) for document text. It's the right tool for
that problem: character-level merge, tombstone-based deletion, and update
encoding that's already commutative and idempotent — exactly what a lossy,
unordered transport needs.

**Not** `y-protocols/awareness` for presence, even though it's built for
this exact use case. Reasons:

- Awareness is designed around a single client's local state and a
  peer-to-peer gossip model; adapting it to "the server is the authority
  that stamps timestamps and rebroadcasts" fights its design rather than
  using it.
- Presence's actual requirements — add/remove per element, deterministic
  tie-breaking, tombstones — are a small, well-understood CRDT (the
  textbook LWW-element-set) that's worth building directly and testing
  against its named laws (commutative, associative, idempotent), rather
  than depending on a library's internal behavior we'd have to verify by
  reading source instead of specification.
- It keeps presence free of any dependency on Yjs's document model, which
  matters because presence and document text have different lifecycles —
  presence for a departed client should disappear on a TTL; document text
  should not.

Implementation: `src/presence/LwwSet.ts`. Per element (keyed by
`clientId`), the set tracks an independent "winning add" record and
"winning remove" record, each `{ value?, timestamp, writerId }`.
Membership is `add.timestamp > remove.timestamp` (see the tie rule below).
Three specific rules, each chosen because the generic "LWW-element-set"
name doesn't actually specify them, and an implementation that picks them
implicitly instead of explicitly is where consistency bugs hide:

### 1. Tie-break between two ops of the same kind

Two concurrent adds (or two concurrent removes) for the same element at
the *same* timestamp are resolved by a plain lexicographic comparison of
`writerId` — the higher string wins. This is a total, deterministic order;
the specific direction ("higher wins") carries no meaning beyond breaking
the tie the same way on every replica.

Equal timestamp **and** equal `writerId` is not a tie needing a rule — it
means the same client's write arrived twice (retransmit, duplicate
delivery), and is a no-op dedupe.

### 2. Tie-break between an add and a remove

An add and a remove for the same element at the same timestamp is a
*different* kind of tie, decided by a fixed, permanent bias rather than
the writerId rule above: **remove wins**. A stale add resurrecting a
departed collaborator's cursor is worse than that collaborator's presence
being briefly (incorrectly) absent, because presence is self-healing in
that direction — the next heartbeat re-adds it — and not in the other:
there's no mechanism that would notice and re-remove a wrongly-resurrected
ghost.

### 3. Timestamp source: server-stamped, not client-supplied

The protocol's `PresenceUpdate` message (client → server) carries no
timestamp field at all — only the value. The server stamps
`Date.now()` at the point it applies the update to the room's `LwwSet`.
This is a hard requirement, not a simplification: LWW's correctness is
entirely a function of timestamps being comparable across writers. A
client with a fast or skewed clock could otherwise author an update
stamped far enough in the future that no other client's update could ever
be timestamped later — permanently winning every future tie. Stamping on
the server removes clock skew as a variable; every timestamp in the system
comes from one clock (or one clock per instance — see the Phase 3 ADR for
how cross-instance clock skew is bounded there).

### 4. Tombstones: bounded, not permanent or immediate

A remove is kept as a tombstone (not deleted outright) so that a
late-arriving, out-of-order add from before the removal loses to it rather
than resurrecting the element. But tombstones are not kept forever:
`pruneTombstones(now)` drops a tombstone once it's older than
`DEFAULT_TOMBSTONE_TTL_MS` (5 minutes — comfortably longer than any
presence TTL Phase 3 introduces, so in practice this window essentially
never matters).

**Tradeoff, stated plainly:** an add delayed by more than the tombstone
TTL after its matching remove will incorrectly resurrect the element,
because by the time it arrives nothing remembers the removal happened.
This is accepted because (a) reconciliation in Phase 3's design closes
divergence well within that window, and (b) presence is soft state anyway
— an incorrect resurrection is bounded by the same heartbeat/TTL mechanism
that bounds every other presence error. The alternative, unbounded
tombstones, means the set grows forever as clients join and leave over the
life of a long-running room — a strictly worse tradeoff for a system meant
to run indefinitely.

## Consequences

- Presence has zero dependency on Yjs — it can be unit-tested, reasoned
  about, and (if ever needed) reused for something that isn't a Yjs
  document, entirely on its own.
- The three rules above are each independently tested in
  `LwwSet.test.ts`, and the overall structure is verified against the
  named CRDT laws (commutative, associative, idempotent) plus a randomized
  convergence test across multiple replicas and arrival orders
  (`LwwSet.convergence.test.ts`) — because a hand-written two-client
  example passes even when a merge implementation is subtly wrong, and a
  property-style test is where that kind of bug actually surfaces.
- The server is now a required part of presence's correctness (it must
  stamp timestamps), which is a small but real coupling — presence cannot
  be computed purely peer-to-peer the way Yjs updates can. Given the
  system already routes all presence updates through a server instance
  (there is no client-to-client path), this costs nothing in practice.
