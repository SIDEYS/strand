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

export interface RoomLifecycleHooks {
  /** Fires synchronously when a room is first created on this instance,
   * before the first member is added. */
  onRoomCreated?(room: Room): void;
  /** Fires when the last local member leaves and the room is dropped. */
  onRoomDestroyed?(room: Room): void;
}

/**
 * Tracks rooms — membership, Yjs doc, presence set — in memory, for a
 * single instance. A room exists on an instance only while it has local
 * members; cross-instance state is the Replicator's job, attached through
 * the lifecycle hooks.
 */
export class RoomManager {
  #rooms = new Map<string, Room>();
  #hooks: RoomLifecycleHooks;

  constructor(hooks: RoomLifecycleHooks = {}) {
    this.#hooks = hooks;
  }

  getOrCreateRoom(roomId: string): Room {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.#rooms.set(roomId, room);
      this.#hooks.onRoomCreated?.(room);
    }
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.#rooms.get(roomId);
  }

  rooms(): IterableIterator<Room> {
    return this.#rooms.values();
  }

  join(roomId: string, member: RoomMember): Room {
    const room = this.getOrCreateRoom(roomId);
    room.members.set(member.clientId, member);
    return room;
  }

  /** Removes a member. When `member` is given, only if that exact
   * connection is still the registered one for the ID: after a resume the
   * newer connection holds the slot, and the older one's late departure
   * must not evict it. */
  leave(roomId: string, clientId: string, member?: RoomMember): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    if (member !== undefined && room.members.get(clientId) !== member) return;
    room.members.delete(clientId);
    if (room.members.size === 0) {
      this.#rooms.delete(roomId);
      this.#hooks.onRoomDestroyed?.(room);
    }
  }

  /** Sends `bytes` to every member of `roomId` except `excludeClientId`
   * (typically the sender, so it doesn't get an echo of its own message). */
  broadcast(roomId: string, bytes: Uint8Array, excludeClientId?: string): void {
    this.#rooms.get(roomId)?.broadcast(bytes, excludeClientId);
  }

  roomSize(roomId: string): number {
    return this.#rooms.get(roomId)?.members.size ?? 0;
  }

  roomCount(): number {
    return this.#rooms.size;
  }
}
