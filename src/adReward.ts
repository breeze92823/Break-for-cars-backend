import { AD_TOKEN_MAX_LEN } from "./constants.js";
import { gameId } from "./auth.js";

// A rewarded ad's token (Bloxity `ads.showRewarded`), asked of Bloxity once:
// POST {BLOXITY_API_URL}/v1/ads/reward/verify { gameSlug, rewardToken } -> { valid, ... }.
// A token verifies once, for this game only, within five minutes. The client only pays out on our
// yes; an outage is a no (the ad can't be proved).
const VERIFY_PATH = "/v1/ads/reward/verify";
const TIMEOUT_MS = 6000;

export async function verifyAdReward(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > AD_TOKEN_MAX_LEN) return false;
  const api = (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
  try {
    const res = await fetch(`${api}${VERIFY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameSlug: gameId(), rewardToken: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { valid?: unknown }).valid === true;
  } catch (err) {
    console.warn("[adReward] verify failed", err);
    return false;
  }
}
