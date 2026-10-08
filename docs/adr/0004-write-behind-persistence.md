# ADR 0004: Write-behind persistence, logged once by the originating instance, snapshotted by any

## Context

Rooms live in instance memory. Persistence has to survive every instance
restarting and Redis being flushed, without putting Postgres in the edit
path, and without a design that only works if exactly one instance hosts a
room: several routinely do, so several see each update.

That makes the interesting question not "how do we write to Postgres" but
"who writes which update, and what happens to an update when its writer
dies."

## Options considered

**Write-through** (persist before acknowledging an edit). Rejected: it puts a
database round trip, and the database's availability, in every keystroke.

**One elected writer per room.** Rejected. It needs a lease, and a lease can
be lost without its holder noticing (ADR 0003 spent a whole mechanism on
exactly that). We would be building an election to avoid a problem the data
model already solves.

**Every instance logs everything, deduplicated by content hash with a unique
constraint.** Rejected, for a reason worth being precise about: it would
look load-bearing and not be. When an instance applies an update it already
partly has, the update event it emits contains only the *new* part, which has
different bytes and a different hash from the original. Yjs also re-encodes
and merges updates. So the hash dedupes opportunistically, never reliably.
It is also unnecessary: duplicates in the log are harmless, because replay is
idempotent and commutative.

**Origin-only logging.** Taken. A Yjs update event carries its origin. An
instance logs an update only when the origin is a client connected to it, and
skips updates that arrived from a peer or were read back from Postgres. Each
edit is therefore logged exactly once, by the instance whose client made it,
with no election, no lease, no write amplification, and no hash.

## Decision

### Write path

A change is pushed onto an in-memory buffer; timers write it later. The
buffer is flushed every `PERSIST_FLUSH_INTERVAL_MS` (250ms) as **one row per
flush per room**: Yjs updates merge, and a row per keystroke would only
bloat the log. The buffer is bounded (`MAX_PENDING_OPS`); on overflow, for
instance while Postgres is slow or down, it is dropped and a snapshot is
forced, because a snapshot holds everything the dropped ops did. Edits are
never blocked on any of this.

### The op log is unordered, and has no sequence

Yjs updates commute, so replay order cannot change the result. A
per-document sequence would make every writer on every instance serialise on
one row lock to assign an ordering that nothing reads. Recovery only needs to
know which ops to apply, not in what order.

Each op instead carries a `base_version`: the document's snapshot version at
the moment of insert. It exists only to drive compaction.

**The writer does not supply it.** It is read from the `documents` table
inside the `INSERT ... SELECT`. An instance's own belief about the current
version can be arbitrarily stale; a stale tag makes an op look old enough for
another instance's compaction to delete before any snapshot contains it. With
the tag taken in the database, it is never older than the version current when
the row was written.

### Snapshots may be written by any instance

Every change, from any origin, marks the room as owing a snapshot. So an
instance holding a change it did not originate will snapshot it. This is the
mitigation for the hole origin-only logging opens: if an originator dies with
ops still in its buffer, those ops are gone from the log, but the other
instances still hold the change in memory and will write it into a snapshot.

A snapshot is the **merge of the stored snapshot and the writer's own
state**, never an overwrite, so a snapshot can only add content. An instance
that is behind, or that failed to read the database on startup, can never
shrink what is stored. (There is a test that fails if this merge is removed;
an earlier version of it passed vacuously because retained ops masked the
bug, which is why the test now compacts the log away first.)

Snapshots are guarded by compare-and-set on `snapshot_version`
(`WHERE snapshot_version < $new`); a loser re-reads, re-merges, and tries
again, so concurrent snapshotters converge rather than clobber. An instance
skips the write when merging its state into the stored snapshot changes
nothing (compared by state vector and delete-set digest), which keeps N
instances from each rewriting the same snapshot every interval. Timers are
jittered for the same reason.

### Compaction and retention

After a successful snapshot at version `V`, ops tagged below `V - R` are
deleted (`OP_RETENTION_VERSIONS`, default 4). Recovery replays every op that
remains.

**This is a heuristic with a stated assumption, not a proof.** An op can only
be safely deleted once some snapshot contains it. We cannot cheaply check
that, so we rely on timing: the originator marks the change as owing a
snapshot the moment it applies it and snapshots within
`SNAPSHOT_INTERVAL_MS`, and `R` is the margin for snapshots by *other*
instances (which may not yet hold the change) interleaving before that
happens. The op is lost from durable state only if all of these hold at once:
more than `R` snapshots by instances lacking the change land before any
instance holding it snapshots; the op is then compacted; and every instance
holding the change dies before it is snapshotted. That is narrow, but it is
not impossible. Raising `R` widens the margin and lengthens the log that
recovery must replay; lowering it does the reverse.

### Recovery

A room loads its snapshot and replays the retained ops into the document in
one transaction, before joiners are served, in parallel with catching up from
peers (both are merges; neither orders the other). State read from Postgres
carries its own origin, so it is neither re-logged nor republished. An
unreadable op row is skipped with an error rather than making the document
unloadable.

Joiners wait for the database, but not indefinitely
(`recoveryTimeoutMs`, 3s). If Postgres is slow or down the room opens with
what peers have, and the persisted state merges in whenever the read
completes. A database outage must not stop people editing.

### Shutdown

A graceful stop flushes every buffer and writes a final snapshot for each
room that owes one. A crash skips that, which is precisely the window below.

## The durability window

This is stated plainly because the design does not remove it.

- **Write-behind means a crash can lose recent edits from the log.** Ops
  reach Postgres up to `PERSIST_FLUSH_INTERVAL_MS` (250ms) after the edit. An
  instance that dies in that interval loses those ops from the log.
- **They may still survive.** If another instance holds the change (it was
  fanned out to a peer) that peer snapshots it within
  `SNAPSHOT_INTERVAL_MS`. The mitigation is partial: it needs a surviving
  holder and it takes up to a snapshot interval, so in the meantime the log
  alone does not have it.
- **If the dying instance was the only holder,** the last ~250ms of its
  clients' edits are gone. The knobs are flush frequency and snapshot
  frequency. There is no claim that this cannot happen, and a test
  (`can lose the most recent unflushed edits in a crash`) demonstrates that it
  does.
- **During a Postgres outage** nothing is written, edits continue, and memory
  is the only copy. The window is then the length of the outage, bounded by
  whatever the surviving instances hold. Overflowing buffers are dropped in
  favour of snapshots that will also fail until the database returns.

## Consequences

- Write load is one row per flush per active room, regardless of how many
  instances host it. No cross-instance coordination on the write path.
- The only contended write is the snapshot, and contention costs a retry
  (another read and merge), not correctness.
- A snapshot costs time proportional to the document (decode, merge, encode)
  and rewrites it whole. Frequent snapshots of very large documents are
  expensive; the interval and op-count thresholds trade that against log
  length.
- Recovery cost grows with the retained log: snapshot read plus replay of
  every op within `R` versions. Measured figures are in the README.
- Persistence is by room ID with no access control: anyone who can join a
  room can read and write its stored document (the service has no auth).
- Documents are never deleted, and a long-lived document's history grows.
