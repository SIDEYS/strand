import { useCallback, useRef, useState } from 'react';
import { Editor } from './Editor.js';
import { PresenceBar } from './PresenceBar.js';
import { Preview } from './Preview.js';
import { StatusBanner, StatusPill } from './StatusPill.js';
import { saveIdentity, type Identity } from './identity.js';
import { scrollFraction, scrollTopForFraction } from './routing.js';
import { useClientSnapshot, useCollab, useDocText } from './useCollab.js';

export function RoomPage({ roomId, identity, onIdentity, onLeave }: {
  roomId: string;
  identity: Identity;
  onIdentity: (next: Identity) => void;
  onLeave: () => void;
}) {
  const client = useCollab(roomId);
  const snapshot = useClientSnapshot(client);
  const text = useDocText(client);
  const [copied, setCopied] = useState(false);

  const editorScroller = useRef<HTMLElement | null>(null);
  const previewScroller = useRef<HTMLDivElement | null>(null);
  // Which pane the user is driving. Setting scrollTop on the other pane fires
  // its own scroll event; without this the two would chase each other.
  const driver = useRef<'editor' | 'preview' | null>(null);
  const release = useRef<number | undefined>(undefined);

  const sync = useCallback((from: 'editor' | 'preview') => {
    const source = from === 'editor' ? editorScroller.current : previewScroller.current;
    const target = from === 'editor' ? previewScroller.current : editorScroller.current;
    if (!source || !target) return;
    if (driver.current !== null && driver.current !== from) return;
    driver.current = from;
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => (driver.current = null), 120);
    target.scrollTop = scrollTopForFraction(
      scrollFraction(source.scrollTop, source.scrollHeight, source.clientHeight),
      target.scrollHeight,
      target.clientHeight,
    );
  }, []);
  const onEditorScroll = useCallback(() => sync('editor'), [sync]);
  const onPreviewScroll = useCallback(() => sync('preview'), [sync]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link to share the room:', window.location.href);
    }
  };

  const rename = (name: string) => {
    const next = { ...identity, name: name.slice(0, 32) || identity.name };
    saveIdentity(next);
    onIdentity(next);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <button onClick={onLeave} className="text-lg font-bold tracking-tight text-indigo-600 dark:text-indigo-400" title="All rooms">
          Strand
        </button>
        <span className="font-mono text-sm text-slate-500" data-testid="room-name">/{roomId}</span>
        {snapshot && <StatusPill snapshot={snapshot} />}
        <div className="ml-auto flex flex-wrap items-center gap-4">
          {snapshot && <PresenceBar identity={identity} peers={snapshot.peers} />}
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            You are
            <input
              value={identity.name}
              onChange={(e) => rename(e.target.value)}
              aria-label="Your display name"
              className="w-36 rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            />
          </label>
          <button onClick={copyLink} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700" data-testid="share">
            {copied ? 'Link copied' : 'Share link'}
          </button>
        </div>
      </header>

      {snapshot && <StatusBanner snapshot={snapshot} onReconnect={() => client?.manualReconnect()} />}

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 divide-y divide-slate-200 md:grid-cols-2 md:grid-rows-1 md:divide-x md:divide-y-0 dark:divide-slate-800">
        <section className="min-h-0 overflow-hidden bg-white dark:bg-slate-900" aria-label="Markdown source">
          {client ? (
            <Editor client={client} identity={identity} onScroll={onEditorScroll} scrollerRef={editorScroller} />
          ) : (
            <div className="p-6 text-slate-500">Connecting…</div>
          )}
        </section>
        <section className="min-h-0 overflow-hidden" aria-label="Rendered preview">
          <Preview ref={previewScroller} markdown={text} onScroll={onPreviewScroll} />
        </section>
      </main>
    </div>
  );
}
