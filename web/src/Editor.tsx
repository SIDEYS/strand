import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { PresenceAwareness } from '../../src/client/awareness.js';
import type { CollabClient } from '../../src/client/core.js';
import type { Identity } from './identity.js';

interface EditorProps {
  client: CollabClient;
  identity: Identity;
  onScroll: () => void;
  /** Receives the scrolling element so the page can sync the other pane to it. */
  scrollerRef: { current: HTMLElement | null };
}

/**
 * The source pane. The document is the client's Yjs text; CodeMirror is just a
 * view of it. Edits made here go into the Yjs doc, the client core sends
 * them, and remote edits arrive the same way, which is what keeps offline
 * typing working: the editor never talks to the network.
 */
export function Editor({ client, identity, onScroll, scrollerRef }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const awarenessRef = useRef<PresenceAwareness | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const ytext = client.doc.getText('content');
    const awareness = new PresenceAwareness(client, { name: identity.name, color: identity.color });
    awarenessRef.current = awareness;

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(ytext, awareness),
          EditorView.theme({
            '&': { height: '100%', fontSize: '15px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
            '.cm-content': { padding: '1.25rem 0.5rem' },
          }),
        ],
      }),
    });
    scrollerRef.current = view.scrollDOM;
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      scrollerRef.current = null;
      view.destroy();
      awareness.destroy();
      awarenessRef.current = null;
    };
    // identity changes are applied in place below; the editor is rebuilt only
    // when the client (the room) changes.
  }, [client]);

  useEffect(() => {
    awarenessRef.current?.setUser({ name: identity.name, color: identity.color });
  }, [identity.name, identity.color]);

  return <div ref={host} className="h-full" data-testid="editor" />;
}
