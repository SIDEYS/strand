import * as Y from 'yjs';

/** The room the public URL opens on. Seeded so it is never empty. */
export const DEFAULT_DEMO_ROOM = 'demo';

/** Fixed, so every instance that builds the seed produces the same items. A
 * random Yjs client ID is 32 bits; this value is one nobody will draw by
 * accident, and a collision would need to be both that and unlucky. */
const SEED_CLIENT_ID = 0x5eed0001;

export const DEMO_MARKDOWN = `# Welcome to Strand

A realtime Markdown editor that stays correct across several servers, with
no sticky sessions. You are looking at the shared **demo** room.

## Try this (it takes a minute)

1. **Open this page in a second window**, side by side. Type in one and watch
   it appear in the other, with a coloured cursor and a name label.
2. **Kill your wifi** in one window (or use DevTools, Network, *Offline*) and
   **keep typing in both**. The status pill changes to *Offline* once the
   connection is genuinely useless, and each window keeps working on its own.
3. **Turn the network back on.** Both windows reconnect as the same person and
   merge every edit. Nothing is lost and nothing is duplicated.

## What is happening underneath

- The text is a **CRDT** (Yjs), so concurrent edits merge instead of
  overwriting each other.
- Cursors are **relative positions**: they stay on the right character even
  while someone else inserts above them.
- The two windows may be served by **different server instances**. Redis carries
  edits between them, and the instances repair anything it drops.
- Rooms are written to Postgres, so this document survives a restart.

> The left pane is Markdown and the right pane is the rendered result. Try a
> list, a table, or some \`inline code\`.

| Try | You should see |
|---|---|
| Select text in one window | A coloured highlight in the other |
| Type above a remote cursor | The cursor stays on its character |
| Go offline and keep editing | Edits queue locally, then merge on reconnect |

Delete all of this and write your own. Share the page URL to invite someone.
`;

let cached: Uint8Array | undefined;

/**
 * The seed as a Yjs update.
 *
 * Seeding has to be safe to do from any instance, at any time, any number of
 * times, because several instances can create the same room independently. A
 * fixed client ID and a fixed text make this update byte-for-byte identical
 * everywhere, so applying it is idempotent: the items it creates already
 * exist in any document that has seen it, and Yjs skips them. That holds
 * even after users delete the text, because deleted items are remembered by
 * ID, so the seed can never resurrect what someone removed.
 */
export function demoSeedUpdate(): Uint8Array {
  if (cached === undefined) {
    const doc = new Y.Doc();
    doc.clientID = SEED_CLIENT_ID;
    doc.getText('content').insert(0, DEMO_MARKDOWN);
    cached = Y.encodeStateAsUpdate(doc);
  }
  return cached;
}
