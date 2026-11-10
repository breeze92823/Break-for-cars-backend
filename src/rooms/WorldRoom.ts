import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { AD_COOLDOWN_MS, FREE_CAR_SAVE_MS, FREE_CAR_SECONDS, NAME_MAX, PFP_MAX_LEN, PLOT_COUNT, RECONNECT_SECONDS, ROOM_MAX_CLIENTS, STAT_MAX, STATS_EVERY_MS } from "../constants.js";
import { accountFor } from "../auth.js";
import { verifyAdReward } from "../adReward.js";
import { queueScores, reportScores } from "../platformBoards.js";
import { Trades } from "../trades.js";
import { applyAvatar, applyBase, applyEmote, applyLoadout, applyPose } from "../presence.js";
import { cleanStep, loadTutorial, saveTutorial } from "../tutorial.js";
import { cleanSeconds, loadFreeCar, markClaimed, savePlayed } from "../freeCar.js";

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
  private tutorialAt = new Map<string, number>(); // sessionId -> the tutorial step known for it
  private tutorialOf = new Map<string, string>(); // sessionId -> the account its step was loaded for
  // The free car (freeCar.ts): sessionId -> the verified account's play clock (`base` s stored when
  // loaded, counted on from `from`, server ms) and whether it was claimed. Guests have none.
  private playOf = new Map<string, { uid: string; base: number; from: number; claimed: boolean }>();
  private freeLocal = new Map<string, unknown>(); // sessionId -> the client's last freeCarSync (its browser's own count)

  private trades = new Trades({
    client: (sid) => this.clients.getById(sid),
    player: (sid) => this.state.players.get(sid),
    later: (ms, fn) => this.clock.setTimeout(fn, ms),
  });

  messages = {
    // Trades (trades.ts): the server brokers requests / offers / accepts; the clients swap the cars.
    tradeRequest: (client: Client, msg: unknown) => this.trades.request(client, msg),
    tradeReply: (client: Client, msg: unknown) => this.trades.reply(client, msg),
    tradeOffer: (client: Client, msg: unknown) => this.trades.offer(client, msg),
    tradeAccept: (client: Client, msg: unknown) => this.trades.accept(client, msg),
    tradeCancel: (client: Client) => this.trades.cancel(client),
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
    // { step }: sent once joined (and its handler set), with the step this browser has reached.
    // Answers `tutorial` { step } for a verified account: where it is, on any browser.
    tutorialSync: (client: Client, msg: { step?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) void this.syncTutorial(client, p, msg?.step);
    },
    // { step }: the tutorial moved on (game/tutorial.js). Saved for a verified account, only upward.
    tutorial: (client: Client, msg: { step?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      const step = cleanStep(msg?.step);
      if (!p || step === null || step <= (this.tutorialAt.get(client.sessionId) ?? -1)) return;
      this.tutorialAt.set(client.sessionId, step);
      if (p.uid) void saveTutorial(p.uid, step);
    },
    // { played, claimed }: sent once joined, with this browser's own count (seeds a new account).
    // Answers `freeCar` { tracked, played?, claimed?, need? }: for a verified account the server's
    // count (it keeps counting while connected); tracked false = a guest, the browser keeps its own.
    freeCarSync: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      this.freeLocal.set(client.sessionId, msg);
      void this.syncFreeCar(client, p);
    },
    // The HUD's free car: answers `freeCarClaim` { ok, reason?: "guest" | "early" | "claimed", played? }.
    // ok only once per account, after FREE_CAR_SECONDS of play on the server clock.
    freeCarClaim: async (client: Client) => {
      const sid = client.sessionId;
      const p = this.state.players.get(sid);
      const rec = this.playOf.get(sid);
      if (!p) return;
      if (!p.uid || !rec || rec.uid !== p.uid) return client.send("freeCarClaim", { ok: false, reason: "guest" });
      const played = this.playedOf(sid);
      if (rec.claimed) return client.send("freeCarClaim", { ok: false, reason: "claimed" });
      if (played < FREE_CAR_SECONDS) return client.send("freeCarClaim", { ok: false, reason: "early", played });
      rec.claimed = true; // before the await: a double click claims once
      const ok = await markClaimed(rec.uid, played);
      if (!this.state.players.has(sid)) return;
      client.send("freeCarClaim", ok ? { ok: true } : { ok: false, reason: "claimed" });
    },
    // Signed in or out mid-session: a new token (or none) and display name. Re-verified.
    identify: async (client: Client, msg: Who) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      const uid = await accountFor(msg);
      if (this.state.players.get(client.sessionId) !== p) return;
      const changed = p.uid !== uid;
      p.uid = uid;
      p.signedIn = !!uid;
      if (changed) {
        void this.syncFreeCar(client, p);
        await this.syncTutorial(client, p, this.tutorialAt.get(client.sessionId));
      }
    },
  };

  onCreate() {
    // Shown with the room in the game page's Open Rooms list.
    void this.setMetadata({ mode: "garages", modeName: "Break for Cars" });
    // The free car's play clocks are saved now and then, not only on leave (a crash loses at most this).
    this.clock.setInterval(() => this.savePlayClocks(), FREE_CAR_SAVE_MS);
  }

  // s of play for the account this session tracks (0 when none).
  playedOf(sid: string): number {
    const rec = this.playOf.get(sid);
    return rec ? rec.base + Math.floor((Date.now() - rec.from) / 1000) : 0;
  }

  async savePlayClocks() {
    await Promise.all([...this.playOf.entries()].map(([sid, rec]) => savePlayed(rec.uid, this.playedOf(sid))));
  }

  // Starts (or restarts, after a sign-in as someone else) the free car's play clock for this session's
  // verified account and tells the client where it stands. A new account (no record) starts from what
  // this browser counted; a known one from what it has stored. A guest gets { tracked: false }.
  async syncFreeCar(client: Client, p: PlayerState): Promise<void> {
    const sid = client.sessionId;
    const prev = this.playOf.get(sid);
    if (prev && prev.uid !== p.uid) {
      this.playOf.delete(sid);
      await savePlayed(prev.uid, prev.base + Math.floor((Date.now() - prev.from) / 1000));
    }
    const uid = p.uid;
    if (!uid) return client.send("freeCar", { tracked: false });
    const known = this.playOf.get(sid);
    if (!known) {
      const stored = await loadFreeCar(uid);
      if (this.state.players.get(sid) !== p || p.uid !== uid) return; // left, or signed in as someone else meanwhile
      if (this.playOf.has(sid)) return this.syncFreeCar(client, p); // a parallel sync got there first
      const local = (this.freeLocal.get(sid) ?? {}) as { played?: unknown; claimed?: unknown };
      const rec = stored
        ? { uid, base: stored.played, from: Date.now(), claimed: stored.claimed }
        : { uid, base: cleanSeconds(local.played) ?? 0, from: Date.now(), claimed: local.claimed === true };
      this.playOf.set(sid, rec);
      if (!stored) {
        if (rec.claimed) await markClaimed(uid, rec.base);
        else await savePlayed(uid, rec.base);
      }
    }
    const rec = this.playOf.get(sid);
    if (!rec || this.state.players.get(sid) !== p) return;
    client.send("freeCar", { tracked: true, played: this.playedOf(sid), claimed: rec.claimed, need: FREE_CAR_SECONDS });
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

  // The tutorial step for this session: the further of what the account has stored and what the
  // client reports (a guest has only the latter). A step the store lacks is saved; the result goes
  // back as `tutorial` { step } so a returning player resumes where they were, on any browser. The
  // store is read once per account per session (`tutorialOf`); a repeat just answers.
  async syncTutorial(client: Client, p: PlayerState, fromClient: unknown) {
    const local = cleanStep(fromClient) ?? 0;
    const sid = client.sessionId;
    if (p.uid && this.tutorialOf.get(sid) === p.uid) {
      const step = Math.max(local, this.tutorialAt.get(sid) ?? 0);
      if (step > (this.tutorialAt.get(sid) ?? -1)) await saveTutorial(p.uid, step);
      this.tutorialAt.set(sid, step);
      return client.send("tutorial", { step });
    }
    const uid = p.uid;
    const stored = uid ? await loadTutorial(uid) : null;
    if (this.state.players.get(sid) !== p || p.uid !== uid) return; // left, or signed in as someone else meanwhile
    if (uid) this.tutorialOf.set(sid, uid);
    const step = Math.max(local, stored ?? 0, this.tutorialAt.get(sid) ?? 0);
    this.tutorialAt.set(sid, step);
    if (!uid) return; // a guest's progress stays in its browser
    if (stored === null || step > stored) await saveTutorial(uid, step);
    client.send("tutorial", { step });
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
    this.trades.leave(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.statsAt.delete(client.sessionId);
    this.adAt.delete(client.sessionId);
    this.tutorialAt.delete(client.sessionId);
    this.tutorialOf.delete(client.sessionId);
    this.freeLocal.delete(client.sessionId);
    const rec = this.playOf.get(client.sessionId);
    if (rec) {
      const played = this.playedOf(client.sessionId);
      this.playOf.delete(client.sessionId);
      await savePlayed(rec.uid, played);
    }
  }

  // The room empties or the pod shuts down (deploy / scale-down SIGTERM): report the queued scores
  // now instead of losing up to PLATFORM_BOARD_EVERY_MS of them. Never throws.
  async onDispose() {
    await Promise.all([reportScores(), this.savePlayClocks()]);
  }
}
