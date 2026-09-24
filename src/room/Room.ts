import * as Y from 'yjs';
import { LwwSet } from '../presence/LwwSet.js';
import type { PresenceValue } from '../presence/types.js';
import type { RoomMember } from './RoomManager.js';

/**
 * Everything a single room needs, held in memory on this instance: its Yjs
 * document, its presence set, and its connected members. Losing this state
 * when the last member leaves (see RoomManager.leave) is a known gap until
 * Phase 5 persistence exists — a room that empties out and refills starts
 * over with a blank document.
 */
export class Room {
  readonly id: string;
  readonly doc = new Y.Doc();
  readonly presence = new LwwSet<PresenceValue>();
  readonly members = new Map<string, RoomMember>();

  constructor(id: string) {
    this.id = id;
  }
}
