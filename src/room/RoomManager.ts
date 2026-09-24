/** Minimal shape RoomManager needs from a connection. Kept decoupled from
 * the gateway's actual Connection class so this module has no I/O and no
 * dependency on `ws` — it's pure bookkeeping over whatever sendable thing
 * you hand it. */
export interface RoomMember {
  readonly clientId: string;
  send(bytes: Uint8Array): void;
}

/**
 * Tracks which connections belong to which room, in memory, for a single
 * instance. Phase 1 is intentionally this simple — Phase 3 is where room
 * membership has to become cross-instance aware via Redis; this class stays
 * the local-instance half of that picture.
 */
export class RoomManager {
  #rooms = new Map<string, Map<string, RoomMember>>();

  join(roomId: string, member: RoomMember): void {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.#rooms.set(roomId, room);
    }
    room.set(member.clientId, member);
  }

  leave(roomId: string, clientId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    room.delete(clientId);
    if (room.size === 0) this.#rooms.delete(roomId);
  }

  /** Sends `bytes` to every member of `roomId` except `excludeClientId`
   * (typically the sender, so it doesn't get an echo of its own message). */
  broadcast(roomId: string, bytes: Uint8Array, excludeClientId?: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    for (const member of room.values()) {
      if (member.clientId === excludeClientId) continue;
      member.send(bytes);
    }
  }

  roomSize(roomId: string): number {
    return this.#rooms.get(roomId)?.size ?? 0;
  }

  roomCount(): number {
    return this.#rooms.size;
  }
}
