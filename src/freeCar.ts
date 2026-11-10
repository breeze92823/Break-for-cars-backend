import { getPlayers } from "./db.js";
import { FREE_CAR_SECONDS } from "./constants.js";

// The HUD's "FREE!" car (client game/freecar.js): one car per account, unlocked after
// FREE_CAR_SECONDS of play. For a verified account the server is the clock: play time is counted on
// the server while the player is connected (WorldRoom), added to what the account already has, and
// stored in Mongo (db.ts `playSeconds`, only ever raised) so it carries over to any device. The claim
// is checked and recorded here (`freeCarClaimed`), so it can be taken once per account. Without Mongo
// (a local server, tests) both live in memory for the life of the process. Guests keep theirs in
// their browser.

export interface FreeCarRecord {
  played: number; // s of play counted for the account
  claimed: boolean;
}

// A client-sent number of seconds as a bounded integer, or null when it is not a number.
export function cleanSeconds(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(FREE_CAR_SECONDS, Math.max(0, Math.floor(v)));
}

const MEMORY_MAX = 10000;
const memory = new Map<string, FreeCarRecord>();
function remember(uid: string, rec: FreeCarRecord) {
  if (!memory.has(uid) && memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
  memory.set(uid, rec);
}

// What `uid` has, null when it has no record yet (a new account) or the database failed.
export async function loadFreeCar(uid: string): Promise<FreeCarRecord | null> {
  const players = getPlayers();
  if (!players) {
    const m = memory.get(uid);
    return m ? { ...m } : null;
  }
  try {
    const doc = await players.findOne({ _id: uid }, { projection: { playSeconds: 1, freeCarClaimed: 1 } });
    if (!doc || (doc.playSeconds === undefined && doc.freeCarClaimed === undefined)) return null;
    return { played: Math.max(0, Math.floor(doc.playSeconds ?? 0)), claimed: doc.freeCarClaimed === true };
  } catch (err) {
    console.warn("[freeCar] load failed", err);
    return null;
  }
}

// Raises the stored play time to `played` s (never lowers it).
export async function savePlayed(uid: string, played: number): Promise<void> {
  played = Math.max(0, Math.floor(played));
  const players = getPlayers();
  if (!players) {
    const m = memory.get(uid);
    if (m && played <= m.played) return;
    remember(uid, { played, claimed: m?.claimed ?? false });
    return;
  }
  try {
    await players.updateOne({ _id: uid }, { $max: { playSeconds: played }, $set: { updatedAt: new Date() } }, { upsert: true });
  } catch (err) {
    console.warn("[freeCar] save failed", err);
  }
}

// Records the claim. true only for the call that claimed it (a second tab, a replay: false).
export async function markClaimed(uid: string, played: number): Promise<boolean> {
  played = Math.max(0, Math.floor(played));
  const players = getPlayers();
  if (!players) {
    const m = memory.get(uid);
    if (m?.claimed) return false;
    remember(uid, { played: Math.max(played, m?.played ?? 0), claimed: true });
    return true;
  }
  try {
    const r = await players.updateOne(
      { _id: uid, freeCarClaimed: { $ne: true } },
      { $set: { freeCarClaimed: true, updatedAt: new Date() }, $max: { playSeconds: played } },
      { upsert: true },
    );
    return r.modifiedCount + r.upsertedCount > 0;
  } catch (err) {
    // E11000: the document exists and is already claimed (the filter missed it, the upsert collided).
    if ((err as { code?: number })?.code !== 11000) console.warn("[freeCar] claim failed", err);
    return false;
  }
}

// Test-only: forget the in-memory records.
export function __resetFreeCarForTest(): void {
  memory.clear();
}
