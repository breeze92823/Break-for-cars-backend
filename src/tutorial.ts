import { getPlayers } from "./db.js";
import { TUTORIAL_DONE_STEP } from "./constants.js";

// The new-player tutorial's progress per verified account (client game/tutorial.js):
// 0 buy a lucky block, 1 place it on a bay, 2 break it, 3 earn the first pickaxe's price,
// 4 buy a pickaxe, TUTORIAL_DONE_STEP = finished. Stored in Mongo (db.ts) and only ever raised
// ($max), so an old tab or a replayed message can never send a player back. Without Mongo (a local
// server, tests) it lives in memory for the life of the process.

// A client-sent step as an integer in range, or null when it is not a number.
export function cleanStep(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(TUTORIAL_DONE_STEP, Math.max(0, Math.floor(v)));
}

const MEMORY_MAX = 10000;
const memory = new Map<string, number>();

// The step stored for `uid`, null when it has none (a new account) or the database failed.
export async function loadTutorial(uid: string): Promise<number | null> {
  const players = getPlayers();
  if (!players) return memory.get(uid) ?? null;
  try {
    const doc = await players.findOne({ _id: uid }, { projection: { tutorialStep: 1 } });
    return doc ? cleanStep(doc.tutorialStep) : null;
  } catch (err) {
    console.warn("[tutorial] load failed", err);
    return null;
  }
}

// Raises the stored step to `step` (never lowers it).
export async function saveTutorial(uid: string, step: number): Promise<void> {
  const players = getPlayers();
  if (!players) {
    if (step <= (memory.get(uid) ?? -1)) return;
    if (!memory.has(uid) && memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
    memory.set(uid, step);
    return;
  }
  try {
    await players.updateOne({ _id: uid }, { $max: { tutorialStep: step }, $set: { updatedAt: new Date() } }, { upsert: true });
  } catch (err) {
    console.warn("[tutorial] save failed", err);
  }
}

// Test-only: forget the in-memory steps.
export function __resetTutorialForTest(): void {
  memory.clear();
}
