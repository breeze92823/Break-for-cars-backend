import { createHash } from "node:crypto";

import { DEV_ID_PREFIX, GAME_SLUG } from "./constants.js";

// Who a player really is (docs.bloxity.io, Multiplayer: "Server identity: trust only the platform").
// The client's Bloxity game token is checked with POST {BLOXITY_API_URL}/v1/auth/game-token/verify
// and only the user id Bloxity returns is used (chat bubbles, leaderboard scores). No token, a
// refused one or an outage = a guest: the id a client sends is never trusted. Off production (a
// local `npm start`, no Bloxity) a VITE_DEV_MODE client's `dev-` id is accepted so two local tabs
// can tell themselves apart.
const VERIFY_PATH = "/v1/auth/game-token/verify";
const TIMEOUT_MS = 6000;
const GOOD_TTL_MS = 60_000; // how long an answer is remembered
const BAD_TTL_MS = 30_000;
const CACHE_MAX = 2000;

const cache = new Map<string, { userId: string; until: number }>();

// Cached by a hash, so this map never holds a usable credential.
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
export const gameId = () => process.env.BLOXITY_GAME_ID || GAME_SLUG;

// The Bloxity id `token` belongs to, "" when it is refused or Bloxity can't be reached.
export async function verifyToken(token: string, now = Date.now()): Promise<string> {
  const key = hashOf(token);
  const known = cache.get(key);
  if (known && known.until > now) return known.userId;

  let userId = "";
  let reached = false;
  try {
    const res = await fetch(`${apiUrl()}${VERIFY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ gameSlug: gameId() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    reached = res.ok || res.status === 401 || res.status === 403;
    if (res.ok) {
      const body = (await res.json()) as { valid?: boolean; user?: { _id?: unknown } };
      const id = body.user?._id;
      if (body.valid !== false && typeof id === "string" && id.length <= 128) userId = id;
    }
  } catch (err) {
    console.warn("[auth] verify failed", err);
  }
  // An outage is not a verdict on the token: the next attempt asks again.
  if (reached) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { userId, until: now + (userId ? GOOD_TTL_MS : BAD_TTL_MS) });
  }
  return userId;
}

// The verified account of a join / `identify`: { token?, devId? } from the client. "" = guest.
export async function accountFor(who: { token?: unknown; devId?: unknown } | undefined, production = process.env.NODE_ENV === "production"): Promise<string> {
  const token = who?.token;
  if (typeof token === "string" && token && token.length <= 8192) return verifyToken(token);
  const dev = who?.devId;
  if (!production && typeof dev === "string" && dev.startsWith(DEV_ID_PREFIX) && dev.length <= 64) return dev;
  return "";
}

// Test-only: forget the cached answers.
export function __resetAuthForTest(): void {
  cache.clear();
}
