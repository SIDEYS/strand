-- Up Migration

CREATE TABLE documents (
  id                 text PRIMARY KEY,
  name               text        NOT NULL,
  -- Yjs state as an update. Every snapshot is the merge of its predecessor
  -- and the writer's state, so a later snapshot always contains an earlier
  -- one and the column can only ever gain content.
  snapshot           bytea,
  -- Bumped by exactly one on each successful snapshot. Doubles as the
  -- compare-and-set guard that lets any instance snapshot without electing
  -- a leader.
  snapshot_version   bigint      NOT NULL DEFAULT 0,
  -- State vector and delete-set digest of `snapshot`, so an instance can tell
  -- cheaply that the stored snapshot already covers what it holds and skip a
  -- redundant write.
  state_vector       bytea,
  delete_set_digest  bytea,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Append-only log of Yjs updates, written by the instance whose client
-- produced them. Deliberately unordered: Yjs updates commute, so replay order
-- cannot change the result, and a per-document sequence would make every
-- writer on every instance serialise on one row lock to assign an ordering
-- nothing reads. `id` is only a row identity and is never used for ordering.
CREATE TABLE document_ops (
  id               bigserial   PRIMARY KEY,
  doc_id           text        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- The document's snapshot_version at the moment this row was inserted. Read
  -- from the table inside the INSERT, never supplied by the writer: a writer
  -- with a stale idea of the version would otherwise tag an op old enough to
  -- be compacted away before any snapshot contains it.
  base_version     bigint      NOT NULL,
  payload          bytea       NOT NULL,
  origin_instance  text        NOT NULL,
  written_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_ops_doc_version_idx ON document_ops (doc_id, base_version);

-- Down Migration

DROP TABLE document_ops;
DROP TABLE documents;
