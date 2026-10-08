import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CollabClient, ClientSnapshot } from '../../src/client/core.js';
import { createBrowserClient } from './browserClient.js';

/** Starts a client for the room for as long as the component is mounted. The
 * client is created in an effect, not during render, so React's dev-mode
 * double mount can't leave a stray socket behind. */
export function useCollab(roomId: string): CollabClient | null {
  const [client, setClient] = useState<CollabClient | null>(null);
  useEffect(() => {
    const { client: created, dispose } = createBrowserClient(roomId);
    setClient(created);
    return () => {
      dispose();
      setClient(null);
    };
  }, [roomId]);
  return client;
}

const NEVER = () => () => undefined;

export function useClientSnapshot(client: CollabClient | null): ClientSnapshot | null {
  return useSyncExternalStore(
    client ? client.subscribe.bind(client) : NEVER,
    () => (client ? client.getSnapshot() : null),
  );
}

/** The document text, kept current as a React value. */
export function useDocText(client: CollabClient | null): string {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!client) {
      setText('');
      return;
    }
    const ytext = client.doc.getText('content');
    const update = () => setText(ytext.toString());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [client]);
  return text;
}
