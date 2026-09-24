export interface PresenceSelection {
  anchor: number;
  head: number;
}

/** What a presence entry carries. Owned by the presence module (not the
 * protocol module) because the wire encoding is a detail of how this value
 * travels, not what it means. */
export interface PresenceValue {
  displayName: string;
  color: string;
  cursor: number | null;
  selection: PresenceSelection | null;
}
