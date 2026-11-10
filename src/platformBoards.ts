import { DEV_ID_PREFIX, PLATFORM_BOARD_BATCH, PLATFORM_BOARD_EVERY_MS, PLATFORM_BOARDS, type BoardId } from "./constants.js";
import { gameId } from "./auth.js";

// The boards behind Bloxity's trophy button and on the game page (docs.bloxity.io, Leaderboards:
// "From your game server"). Verified players' scores are queued here and reported in batches with
// POST {BLOXITY_API_URL}/v1/leaderboards/hosted/{BLOXITY_GAME_ID}/report. A no-op unless deployed by
// Bloxity hosting (BLOXITY_REPORT_TOKEN), so it is safe locally. PLATFORM_BOARDS must match the
// client's LEADERBOARDS (config.js), which declares them too (that is what shows the trophy button).
type Scores = Partial<Record<BoardId, number>>;

const queued = new Map<string, Scores>(); // Bloxity user id -> the latest scores not reported yet

export function queueScores(userId: string, scores: Scores): void {
  if (!process.env.BLOXITY_REPORT_TOKEN || !userId || userId.startsWith(DEV_ID_PREFIX)) return;
  queued.set(userId, { ...queued.get(userId), ...scores });
}

export async function reportScores(): Promise<void> {
  const token = process.env.BLOXITY_REPORT_TOKEN;
  if (!token || !queued.size) return;

  const scores: { board: string; userId: string; score: number }[] = [];
  for (const [userId, stats] of queued) {
    // Only `legion_` identities rank; a `#m...` mode suffix is stripped.
    const bare = userId.split("#")[0].replace(/^legion_/, "");
    for (const [board, value] of Object.entries(stats)) {
      if (Number.isFinite(value) && (value as number) > 0) scores.push({ board, userId: `legion_${bare}`, score: Math.floor(value as number) });
    }
    queued.delete(userId);
    if (scores.length >= PLATFORM_BOARD_BATCH - PLATFORM_BOARDS.length) break;
  }
  if (!scores.length) return;

  const api = (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
  try {
    const res = await fetch(`${api}/v1/leaderboards/hosted/${gameId()}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ boards: PLATFORM_BOARDS, scores }),
      signal: AbortSignal.timeout(6000),
    });
    const body: { dropped?: unknown } | null = await res.json().catch((): null => null);
    if (body?.dropped) console.warn("[boards] dropped", body.dropped);
    if (!res.ok) console.warn("[boards] report failed", res.status);
  } catch (err) {
    console.warn("[boards] report failed", err);
  }
}

export function installPlatformBoards(): void {
  if (!process.env.BLOXITY_REPORT_TOKEN) return;
  setInterval(() => void reportScores(), PLATFORM_BOARD_EVERY_MS).unref();
}

// Test-only.
export function __queuedForTest(): Map<string, Scores> {
  return queued;
}
