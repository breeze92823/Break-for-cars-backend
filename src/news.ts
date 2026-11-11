import { getPlayers } from "./db.js";
import { NEWS_VERSION_MAX } from "./constants.js";

// The "New Update!" window (client game/news.js, config NEWS.version): the newest update version each
// verified account has seen, so the window shows once per update per account, on any device. Stored in
// Mongo (db.ts) and only ever raised ($max). Without Mongo (a local server, tests) it lives in memory
// for the life of the process.

// A client-sent version as an integer in range, or null when it is not a number.
export function cleanVersion(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(NEWS_VERSION_MAX, Math.max(0, Math.floor(v)));
}

const MEMORY_MAX = 10000;
const memory = new Map<string, number>();

// The version stored for `uid`, null when it has none (a new account) or the database failed.
export async function loadNews(uid: string): Promise<number | null> {
  const players = getPlayers();
  if (!players) return memory.get(uid) ?? null;
  try {
    const doc = await players.findOne({ _id: uid }, { projection: { newsSeen: 1 } });
    return doc ? cleanVersion(doc.newsSeen) : null;
  } catch (err) {
    console.warn("[news] load failed", err);
    return null;
  }
}

// Raises the stored version to `version` (never lowers it).
export async function saveNews(uid: string, version: number): Promise<void> {
  const players = getPlayers();
  if (!players) {
    if (version <= (memory.get(uid) ?? -1)) return;
    if (!memory.has(uid) && memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
    memory.set(uid, version);
    return;
  }
  try {
    await players.updateOne({ _id: uid }, { $max: { newsSeen: version }, $set: { updatedAt: new Date() } }, { upsert: true });
  } catch (err) {
    console.warn("[news] save failed", err);
  }
}

// Test-only: forget the in-memory versions.
export function __resetNewsForTest(): void {
  memory.clear();
}
