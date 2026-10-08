import type { ClientSnapshot } from '../../src/client/core.js';

const STYLES: Record<string, string> = {
  connected: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  connecting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  reconnecting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  offline: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
};

const DOTS: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  offline: 'bg-rose-500',
  failed: 'bg-rose-500',
};

function label(snapshot: ClientSnapshot): string {
  switch (snapshot.status) {
    case 'connected':
      return snapshot.synced ? 'Connected' : 'Syncing';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline';
    case 'failed':
      return 'Disconnected';
  }
}

export function StatusPill({ snapshot }: { snapshot: ClientSnapshot }) {
  const pending = snapshot.unsyncedLocalUpdates;
  return (
    <span
      role="status"
      data-testid="status-pill"
      data-status={snapshot.status}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${STYLES[snapshot.status]}`}
    >
      <span className={`h-2 w-2 rounded-full ${DOTS[snapshot.status]}`} />
      {label(snapshot)}
      {pending > 0 && snapshot.status !== 'connected' && (
        <span className="opacity-80" data-testid="pending-count">
          · {pending} {pending === 1 ? 'edit' : 'edits'} saved here
        </span>
      )}
    </span>
  );
}

/** The one-line explanation under the header when something needs saying. */
export function StatusBanner({ snapshot, onReconnect }: { snapshot: ClientSnapshot; onReconnect: () => void }) {
  if (snapshot.status === 'offline' || snapshot.status === 'reconnecting') {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100" data-testid="offline-banner">
        {snapshot.status === 'offline' ? "You're offline. " : 'Reconnecting. '}
        <strong>Keep typing</strong>: your edits are saved in this window and will merge with everyone else's when the connection comes back.
      </div>
    );
  }
  if (snapshot.state.status === 'failed') {
    const reason = snapshot.state.reason;
    return (
      <div className="flex items-center justify-between gap-4 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100" data-testid="failed-banner">
        <span>
          {reason === 'superseded' && 'This session was opened in another window, so this one stopped.'}
          {reason === 'version-mismatch' && 'This page is out of date and cannot talk to the server. Reload to update.'}
          {reason === 'protocol-error' && 'The server rejected a message from this page. Reload to try again.'}
        </span>
        {reason === 'superseded' ? (
          <button onClick={onReconnect} className="rounded bg-rose-600 px-3 py-1 font-medium text-white hover:bg-rose-700">
            Use this window
          </button>
        ) : (
          <button onClick={() => window.location.reload()} className="rounded bg-rose-600 px-3 py-1 font-medium text-white hover:bg-rose-700">
            Reload
          </button>
        )}
      </div>
    );
  }
  return null;
}
