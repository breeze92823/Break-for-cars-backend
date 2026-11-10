import type { Client } from "colyseus";
import { ID_PATTERN, LEVEL_MAX, MONEY_MAX, NAME_PATTERN, TRADE_INVITE_MS, TRADE_REACH_M, TRADE_SLOTS } from "./constants.js";

// Trades between two players in the room. The server only brokers it: it checks who may trade with
// whom, relays each side's offer (cars from the hotbar, re-shaped here), clears both sides' "accept"
// whenever an offer changes, and tells both clients to swap when both have accepted. The cars
// themselves live in the browsers (the game is client-authoritative); each client holds its offered
// cars aside while the trade is open and hands them over on `tradeDone`.

export interface TradeCar {
  theme: string;
  rarity: string;
  name: string;
  look: string;
  base: number;
  level: number;
  spent: number;
  variant?: string;
}

interface Side {
  sid: string;
  items: TradeCar[];
  accepted: boolean;
}
interface Trade {
  id: number;
  a: Side;
  b: Side;
}

// What the trades need from the room.
export interface TradeHost {
  client(sid: string): Client | undefined;
  player(sid: string): { x: number; z: number; username: string } | undefined;
  later(ms: number, fn: () => void): { clear(): void };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const num = (v: unknown, max: number, dflt = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : dflt);

// One hotbar car as the client keeps it (game.js state.cars): catalog ids, name, level, money.
export function sanitizeCar(v: unknown): TradeCar | null {
  const m = obj(v);
  if (!m || !isId(m.theme) || !isId(m.rarity) || !isId(m.look)) return null;
  if (typeof m.name !== "string" || !NAME_PATTERN.test(m.name)) return null;
  const car: TradeCar = {
    theme: m.theme,
    rarity: m.rarity,
    name: m.name,
    look: m.look,
    base: num(m.base, MONEY_MAX),
    level: Math.max(1, Math.round(num(m.level, LEVEL_MAX, 1))),
    spent: num(m.spent, MONEY_MAX),
  };
  if (isId(m.variant)) car.variant = m.variant;
  return car;
}

export class Trades {
  private nextId = 1;
  private bySession = new Map<string, Trade>();
  private invites = new Map<string, { from: string; timer: { clear(): void } }>(); // target sessionId -> who asked

  constructor(private host: TradeHost) {}

  private name(sid: string): string {
    return this.host.player(sid)?.username || "Player";
  }
  private busy(sid: string): boolean {
    if (this.bySession.has(sid) || this.invites.has(sid)) return true;
    for (const i of this.invites.values()) if (i.from === sid) return true;
    return false;
  }

  // `tradeRequest` { to }: ask another player to trade (they must be near and free).
  request(from: Client, msg: unknown): void {
    const to = obj(msg)?.to;
    if (typeof to !== "string" || to === from.sessionId) return;
    const a = this.host.player(from.sessionId);
    const b = this.host.player(to);
    const target = this.host.client(to);
    if (!a || !b || !target) return;
    const decline = (reason: string) => from.send("tradeDeclined", { name: this.name(to), reason });
    if (this.busy(from.sessionId) || this.busy(to)) return decline("busy");
    if (Math.hypot(a.x - b.x, a.z - b.z) > TRADE_REACH_M) return decline("far");
    const timer = this.host.later(TRADE_INVITE_MS, () => {
      this.invites.delete(to);
      from.send("tradeDeclined", { name: this.name(to), reason: "timeout" });
      target.send("tradeInviteEnd", { from: from.sessionId });
    });
    this.invites.set(to, { from: from.sessionId, timer });
    target.send("tradeInvite", { from: from.sessionId, name: this.name(from.sessionId) });
    from.send("tradeSent", { to, name: this.name(to) });
  }

  // `tradeReply` { from, accept }: the asked player answers.
  reply(client: Client, msg: unknown): void {
    const m = obj(msg);
    const inv = this.invites.get(client.sessionId);
    if (!m || !inv || inv.from !== m.from) return;
    inv.timer.clear();
    this.invites.delete(client.sessionId);
    const asker = this.host.client(inv.from);
    if (!asker || !this.host.player(inv.from)) return;
    if (m.accept !== true) return asker.send("tradeDeclined", { name: this.name(client.sessionId), reason: "declined" });
    const trade: Trade = {
      id: this.nextId++,
      a: { sid: inv.from, items: [], accepted: false },
      b: { sid: client.sessionId, items: [], accepted: false },
    };
    this.bySession.set(trade.a.sid, trade);
    this.bySession.set(trade.b.sid, trade);
    asker.send("tradeStart", { partner: trade.b.sid, name: this.name(trade.b.sid) });
    client.send("tradeStart", { partner: trade.a.sid, name: this.name(trade.a.sid) });
  }

  private sides(client: Client): { trade: Trade; me: Side; them: Side } | null {
    const trade = this.bySession.get(client.sessionId);
    if (!trade) return null;
    const mine = trade.a.sid === client.sessionId;
    return { trade, me: mine ? trade.a : trade.b, them: mine ? trade.b : trade.a };
  }

  private push(trade: Trade): void {
    for (const [me, them] of [
      [trade.a, trade.b],
      [trade.b, trade.a],
    ] as const) {
      this.host.client(me.sid)?.send("tradeState", { mine: me.items, theirs: them.items, meAccepted: me.accepted, themAccepted: them.accepted });
    }
  }

  // `tradeOffer` { items }: this side's cars. Any change clears both accepts.
  offer(client: Client, msg: unknown): void {
    const s = this.sides(client);
    const raw = obj(msg)?.items;
    if (!s || !Array.isArray(raw)) return;
    s.me.items = raw.slice(0, TRADE_SLOTS).map(sanitizeCar).filter((c): c is TradeCar => !!c);
    s.me.accepted = false;
    s.them.accepted = false;
    this.push(s.trade);
  }

  // `tradeAccept` { accepted }: both accepted (with something on the table) completes the trade.
  accept(client: Client, msg: unknown): void {
    const s = this.sides(client);
    if (!s) return;
    s.me.accepted = obj(msg)?.accepted === true && s.me.items.length + s.them.items.length > 0;
    this.push(s.trade);
    if (!(s.me.accepted && s.them.accepted)) return;
    this.release(s.trade);
    this.host.client(s.me.sid)?.send("tradeDone", { received: s.them.items });
    this.host.client(s.them.sid)?.send("tradeDone", { received: s.me.items });
  }

  // `tradeCancel`: either side closes the window (or withdraws a request).
  cancel(client: Client): void {
    const s = this.sides(client);
    if (s) this.end(s.trade, "cancelled", client.sessionId);
    this.dropInvites(client.sessionId, "cancelled");
  }

  // A player left: end their trade and any request they sent or hold.
  leave(sid: string): void {
    const trade = this.bySession.get(sid);
    if (trade) this.end(trade, "left", sid);
    this.dropInvites(sid, "left");
  }

  private release(trade: Trade): void {
    this.bySession.delete(trade.a.sid);
    this.bySession.delete(trade.b.sid);
  }

  private end(trade: Trade, reason: string, by: string): void {
    this.release(trade);
    for (const side of [trade.a, trade.b]) if (side.sid !== by) this.host.client(side.sid)?.send("tradeEnd", { reason, name: this.name(by) });
  }

  private dropInvites(sid: string, reason: string): void {
    const held = this.invites.get(sid);
    if (held) {
      held.timer.clear();
      this.invites.delete(sid);
      this.host.client(held.from)?.send("tradeDeclined", { name: this.name(sid), reason });
    }
    for (const [target, inv] of this.invites) {
      if (inv.from !== sid) continue;
      inv.timer.clear();
      this.invites.delete(target);
      this.host.client(target)?.send("tradeInviteEnd", { from: sid });
    }
  }
}
