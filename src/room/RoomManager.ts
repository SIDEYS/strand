import { Room } from './Room.js';

/** Minimal shape RoomManager needs from a connection. Kept decoupled from
 * the gateway's actual Connection class so this module has no dependency
 * on `ws` — it's pure bookkeeping over whatever sendable thing you hand
 * it. (Room itself does pull in Yjs and the presence set, since a room's
 * identity now includes its document, not just its member list.) */
export interface RoomMember {
  readonly clientId: string;
  send(bytes: Uint8Array): void;
}

/**
 * Tracks rooms — membership, Yjs doc, presence set — in memory, for a
 * single instance. Phase 1/2 are intentionally this simple; Phase 3 is
 * where room state has to become cross-instance aware via Redis, and this
 * class stays the local-instance half of that picture.
 */
export class RoomManager {
  #rooms = new Map<string, Room>();

  getOrCreateRoom(roomId: string): Room {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.#rooms.set(roomId, room);
    }
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.#rooms.get(roomId);
  }

  join(roomId: string, member: RoomMember): Room {
    const room = this.getOrCreateRoom(roomId);
    room.members.set(member.clientId, member);
    return room;
  }

  leave(roomId: string, clientId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    room.members.delete(clientId);
    if (room.members.size === 0) this.#rooms.delete(roomId);
  }

  /** Sends `bytes` to every member of `roomId` except `excludeClientId`
   * (typically the sender, so it doesn't get an echo of its own message). */
  broadcast(roomId: string, bytes: Uint8Array, excludeClientId?: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    for (const member of room.members.values()) {
      if (member.clientId === excludeClientId) continue;
      member.send(bytes);
    }
  }

  roomSize(roomId: string): number {
    return this.#rooms.get(roomId)?.members.size ?? 0;
  }

  roomCount(): number {
    return this.#rooms.size;
  }
}
