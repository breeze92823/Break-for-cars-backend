import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion injects MONGODB_URI per game + channel (an isolated database with scoped
// credentials). A local `npm start` usually has no Mongo at all, so a missing or unreachable URI
// degrades to "no database" (tutorial.ts then keeps progress in memory) instead of crashing.
// Only what the server has to remember per account lives here; the rest of the game still saves
// in the browser.
export interface PlayerDoc {
  _id: string; // the Bloxity user id the server verified (auth.ts), never one a client sent
  tutorialStep?: number; // 0..TUTORIAL_DONE_STEP (constants.ts), only ever raised
  playSeconds?: number; // s of play the server counted (freeCar.ts), only ever raised
  freeCarClaimed?: boolean; // the HUD's free car was taken (freeCar.ts), once per account
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

// Never throws; resolves once connected or once it has given up.
export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set: tutorial + free-car progress is kept in memory only");
    return;
  }
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    // No db name: the injected URI already points at this game + channel's own database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
  } catch (err) {
    console.warn("[db] connect failed: tutorial + free-car progress is kept in memory only", err);
    await client?.close().catch(() => {});
    client = null;
    players = null;
  }
}

// null when Mongo is unset or unreachable: callers fall back, never throw.
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only: run against a fake collection (or none).
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
