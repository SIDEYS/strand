import * as Y from 'yjs';
import { LwwSet } from '../presence/LwwSet.js';
import type { PresenceValue } from '../presence/types.js';
import type { RoomMember } from './RoomManager.js';

/** Transaction origin for Yjs updates that arrived from another instance
 * (or from reconciliation). The doc's update handler uses it to decide
 * whether an update still needs publishing: remote-origin updates must not
 * be published again, or every instance would echo every update forever. */
export const REMOTE_ORIGIN = Symbol('remote-origin');

/**
 * Everything a single room needs, held in memory on this instance: its Yjs
 * document, its presence set, and its connected members. Losing this state
 * when the last member leaves (see RoomManager.leave) is a known gap until
 * Phase 5 persistence exists — a room that empties out and refills starts
 * over with a blank document (or, with peers, is rebuilt from them).
 */
export class Room {
  readonly id: string;
  readonly doc = new Y.Doc();
  readonly presence = new LwwSet<PresenceValue>();
  readonly members = new Map<string, RoomMember>();
  /** Settles once this instance has had a chance to catch up with peers
   * after creating the room. Joiners wait on it before being told what the
   * room contains, so they don't get a blank document that peers already
   * have content for. Resolves immediately when there is no fan-out. */
  ready: Promise<void> = Promise.resolve();

  constructor(id: string) {
    this.id = id;
  }

  /** Sends to every local member except `excludeClientId`. */
  broadcast(bytes: Uint8Array, excludeClientId?: string): void {
    for (const member of this.members.values()) {
      if (member.clientId === excludeClientId) continue;
      member.send(bytes);
    }
  }

  /**
   * Sends a document update to local members, skipping any that haven't had
   * their initial sync yet. Such a member is about to be sent the whole
   * current document as a diff against its own state vector, computed after
   * this update was applied, so it already covers it. Sending the update too
   * would deliver the same content twice, and on a cold instance rebuilding
   * the room from a peer that is the entire document, to a client that just
   * reconnected holding nearly all of it.
   */
  broadcastDocUpdate(bytes: Uint8Array, excludeClientId?: string): void {
    for (const member of this.members.values()) {
      if (member.clientId === excludeClientId || member.awaitingSync === true) continue;
      member.send(bytes);
    }
  }

  /** Applies a presence add that originated elsewhere. Returns true if
   * what a viewer would see changed (membership or value) — a bare
   * timestamp bump from a heartbeat refresh is not worth re-broadcasting. */
  applyRemotePresenceAdd(clientId: string, value: PresenceValue, timestamp: number): boolean {
    const before = JSON.stringify(this.presence.get(clientId) ?? null);
    this.presence.add(clientId, value, timestamp, clientId);
    return JSON.stringify(this.presence.get(clientId) ?? null) !== before;
  }

  applyRemotePresenceRemove(clientId: string, timestamp: number): boolean {
    const was = this.presence.has(clientId);
    this.presence.remove(clientId, timestamp, clientId);
    return was && !this.presence.has(clientId);
  }
}
