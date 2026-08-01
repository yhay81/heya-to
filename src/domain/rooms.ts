export const roomPurposes = ["random", "event", "song", "support", "other"] as const;
export type RoomPurpose = (typeof roomPurposes)[number];

export const roomRules = [
  "conditions",
  "difficulty-free",
  "efficient-song-ok",
  "long-run",
  "mistakes-ok",
  "sf-none",
  "withdraw-ok",
] as const;
export type RoomRule = (typeof roomRules)[number];

const purposeSet = new Set<string>(roomPurposes);
const ruleSet = new Set<string>(roomRules);

export const isRoomCode = (value: string) => /^\d{5}$/u.test(value);

export const isRoomPurpose = (value: string): value is RoomPurpose => purposeSet.has(value);

export const normalizeRoomRules = (values: unknown): RoomRule[] | null => {
  if (!Array.isArray(values) || values.length > roomRules.length) return null;
  if (values.some((value) => typeof value !== "string" || !ruleSet.has(value))) return null;
  return [...new Set(values as RoomRule[])].sort();
};

export const minutesRemaining = (expiresAt: number, now: number) =>
  Math.max(0, Math.ceil((expiresAt - now) / 60));

export const extensionExpiry = (createdAt: number, now: number) =>
  Math.min(now + 12 * 60, createdAt + 30 * 60);
