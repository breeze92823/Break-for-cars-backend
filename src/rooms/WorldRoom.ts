import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { AD_COOLDOWN_MS, NAME_MAX, PFP_MAX_LEN, PLOT_COUNT, RECONNECT_SECONDS, ROOM_MAX_CLIENTS, STAT_MAX, STATS_EVERY_MS } from "../constants.js";
import { accountFor } from "../auth.js";
import { verifyAdReward } from "../adReward.js";
import { queueScores } from "../platformBoards.js";
import { applyAvatar, applyBase, applyEmote, applyLoadout, applyPose } from "../presence.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

const stat = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, STAT_MAX) : undefined);

// What a client says about itself: its Bloxity game token (verified, auth.ts), or a `dev-` id from
// a VITE_DEV_MODE client (trusted off production only), plus display name and profile picture.
interface Who {
  token?: string;
  devId?: string;
  username?: string;
  pfp?: string;
}

interface JoinOptions extends Who {
  plot?: unknown; // the garage the client is already playing on (kept when free)
  pose?: unknown;
  loadout?: unknown;
  avatar?: string;
  base?: unknown;
}

/**
 * Room every client joins via the Bloxity matchmaker with `client.joinOrCreate("world", options)`.
 * Up to ROOM_MAX_CLIENTS players; each owns one of the island's PLOT_COUNT garages (`plot`), the one
 * it asked for when free, else the lowest free one. Everything a player does is relayed through the
 * roster (presence.ts) so the others draw them, their pickaxe, swings, emotes and their garage
 * (read-only on the other clients). The game itself is client-authoritative and saves in the
 * browser; the server keeps no progress. Verified players' scores go to Bloxity's boards.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  private statsAt = new Map<string, number>(); // sessionId -> last accepted `stats` (server clock)
  private adAt = new Map<string, number>(); // sessionId -> when the next ad reward is allowed

  messages = {
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    base: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyBase(p, msg);
    },
    // A pickaxe swing: the others play it (the counter wraps; only a change matters).
    swing: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.swing = (p.swing + 1) & 0xffff;
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // { cash, income, playtime } every few seconds: queued for Bloxity's boards under the VERIFIED id
    // only (guests and unverified sessions report nothing). Rate-limited per session.
    stats: (client: Client, msg: { cash?: unknown; income?: unknown; playtime?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.uid) return;
      const now = Date.now();
      if (now - (this.statsAt.get(client.sessionId) ?? 0) < STATS_EVERY_MS) return;
      this.statsAt.set(client.sessionId, now);
      const cash = stat(msg?.cash);
      const income = stat(msg?.income);
      const playtime = stat(msg?.playtime);
      queueScores(p.uid, {
        ...(cash !== undefined && { cash }),
        ...(income !== undefined && { income }),
        ...(playtime !== undefined && { playtime }),
      });
    },
    // A rewarded ad finished on the client (Bloxity `ads.showRewarded`): its token is checked with
    // Bloxity before the client pays out. Answers `adReward` { ok, reason?: "cooldown" | "invalid" }.
    adReward: async (client: Client, msg: { rewardToken?: unknown }) => {
      const now = Date.now();
      if (now < (this.adAt.get(client.sessionId) ?? 0)) return client.send("adReward", { ok: false, reason: "cooldown" });
      const ok = await verifyAdReward(msg?.rewardToken);
      if (!this.state.players.has(client.sessionId)) return;
      if (!ok) return client.send("adReward", { ok: false, reason: "invalid" });
      this.adAt.set(client.sessionId, now + AD_COOLDOWN_MS);
      client.send("adReward", { ok: true });
    },
    // Signed in or out mid-session: a new token (or none) and display name. Re-verified.
    identify: async (client: Client, msg: Who) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      const uid = await accountFor(msg);
      if (this.state.players.get(client.sessionId) !== p) return;
      p.uid = uid;
      p.signedIn = !!uid;
    },
  };

  onCreate() {
    // Shown with the room in the game page's Open Rooms list.
    void this.setMetadata({ mode: "garages", modeName: "Break for Cars" });
  }

  // The garage `want` when nobody in this room holds it, else the lowest free one (-1 only if every
  // plot is taken, which maxClients = PLOT_COUNT rules out).
  freePlot(want: unknown): number {
    const taken = new Set<number>();
    this.state.players.forEach((p) => taken.add(p.plot));
    if (Number.isInteger(want) && (want as number) >= 0 && (want as number) < PLOT_COUNT && !taken.has(want as number)) return want as number;
    for (let i = 0; i < PLOT_COUNT; i++) if (!taken.has(i)) return i;
    return -1;
  }

  async onJoin(client: Client, options?: JoinOptions) {
    const p = new PlayerState();
    p.plot = this.freePlot(options?.plot);
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer and their garage right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    applyBase(p, options?.base);
    this.state.players.set(client.sessionId, p);
    const uid = await accountFor(options);
    if (this.state.players.get(client.sessionId) !== p) return; // left while the token was checked
    p.uid = uid;
    p.signedIn = !!uid;
  }

  // A deliberate `room.leave()` closes with CONSENTED: drop the player (and free the garage) at
  // once. Anything else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to come back to the
  // same session and garage.
  async onLeave(client: Client, code?: number) {
    if (code !== CloseCode.CONSENTED) {
      try {
        await this.allowReconnection(client, RECONNECT_SECONDS);
        return;
      } catch {
        // Not back in time.
      }
    }
    this.state.players.delete(client.sessionId);
    this.statsAt.delete(client.sessionId);
    this.adAt.delete(client.sessionId);
  }
}
