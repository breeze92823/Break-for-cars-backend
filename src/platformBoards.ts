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
  await post(token, scores);
}

// One report call; the board declarations ride along every time, so Bloxity creates (upserts) the
// boards even before the client's define() has run inside the portal. Never throws.
async function post(token: string, scores: { board: string; userId: string; score: number }[]): Promise<boolean> {
  const api = (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
  try {
    const res = await fetch(`${api}/v1/leaderboards/hosted/${gameId()}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ boards: PLATFORM_BOARDS, scores }),
      signal: AbortSignal.timeout(8000),
    });
    const body: { dropped?: Record<string, number> } | null = await res.json().catch((): null => null);
    if (body?.dropped && Object.values(body.dropped).some((n) => n > 0)) console.warn("[boards] dropped", body.dropped);
    if (!res.ok) console.warn("[boards] report failed", res.status, body);
    return res.ok;
  } catch (err) {
    console.warn("[boards] report failed", err);
    return false;
  }
}

export function installPlatformBoards(): void {
  const token = process.env.BLOXITY_REPORT_TOKEN;
  if (!token) return;
  // Declare the boards at boot, so the trophy button and the plaza boards (getTop) find them
  // instead of "Board not found" while no signed-in player has reported a score yet.
  void post(token, []).then((ok) => ok && console.info("[boards] declared", PLATFORM_BOARDS.map((b) => b.id).join(", ")));
  setInterval(() => void reportScores(), PLATFORM_BOARD_EVERY_MS).unref();
}

// Test-only.
export function __queuedForTest(): Map<string, Scores> {
  return queued;
}
