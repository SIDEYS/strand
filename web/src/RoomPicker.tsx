import { useState } from 'react';
import { loadRecentRooms } from './identity.js';
import { randomRoomId, roomSlug } from './routing.js';

export function RoomPicker({ onOpen }: { onOpen: (roomId: string) => void }) {
  const [name, setName] = useState('');
  const slug = roomSlug(name);
  const recent = loadRecentRooms();

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6 py-12 text-slate-900 dark:text-slate-100">
      <div>
        <h1 className="text-4xl font-bold tracking-tight text-indigo-600 dark:text-indigo-400">Strand</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          A realtime Markdown editor that keeps working when the network doesn't. Pick a room and share its link.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (slug) onOpen(slug);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name, e.g. design-review"
          aria-label="Room name"
          className="min-w-0 flex-1 rounded border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
        />
        <button disabled={!slug} className="rounded bg-indigo-600 px-4 py-2 font-medium text-white enabled:hover:bg-indigo-700 disabled:opacity-40">
          Open
        </button>
      </form>
      {name && slug && slug !== name && <p className="-mt-6 text-sm text-slate-500">Will open as <code>/{slug}</code></p>}

      <div className="flex flex-wrap gap-3">
        <button onClick={() => onOpen(randomRoomId(Math.random))} className="rounded border border-slate-300 px-4 py-2 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
          Start a new room
        </button>
        <button onClick={() => onOpen('demo')} className="rounded border border-indigo-300 bg-indigo-50 px-4 py-2 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200" data-testid="open-demo">
          Try the demo room
        </button>
      </div>

      {recent.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Recent</h2>
          <ul className="flex flex-wrap gap-2">
            {recent.map((room) => (
              <li key={room}>
                <button onClick={() => onOpen(room)} className="rounded-full bg-slate-200 px-3 py-1 font-mono text-sm hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700">
                  {room}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
