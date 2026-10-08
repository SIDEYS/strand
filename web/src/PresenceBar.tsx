import type { Peer } from '../../src/client/core.js';
import type { Identity } from './identity.js';
import { initials } from './routing.js';

function Avatar({ name, color, you }: { name: string; color: string; you?: boolean }) {
  return (
    <span
      title={you ? `${name} (you)` : name}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-white dark:ring-slate-900"
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </span>
  );
}

/** Who is in the room right now, you first. */
export function PresenceBar({ identity, peers }: { identity: Identity; peers: readonly Peer[] }) {
  return (
    <div className="flex items-center gap-2" data-testid="presence-bar" aria-label="People in this room">
      <div className="flex -space-x-2">
        <Avatar name={identity.name} color={identity.color} you />
        {peers.map((peer) => (
          <Avatar key={peer.clientId} name={peer.value.displayName} color={peer.value.color} />
        ))}
      </div>
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {peers.length === 0 ? 'Just you' : `You and ${peers.length} ${peers.length === 1 ? 'other' : 'others'}`}
      </span>
    </div>
  );
}
