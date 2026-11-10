import { AVATAR_MAX_LEN, BAYS_MAX, BASE_MAX_LEN, CONVEYOR_LEVEL_MAX, EMOTE_PATTERN, ID_PATTERN, LEVEL_MAX, MONEY_MAX, NAME_PATTERN, POSE_BOUNDS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player and their garage (client remotePlayers.js,
// remoteBases.js). Relayed through the roster as sent, only bounded and re-shaped here: the game is
// client-authoritative and none of this is used for anything but drawing.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const isName = (v: unknown): v is string => typeof v === "string" && NAME_PATTERN.test(v);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// `pose` { x, y, z, yaw, speed }: feet position (m), heading (rad), ground speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  const m = obj(msg);
  if (!m) return;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xyz, b.xyz);
  if (finite(m.y)) p.y = clamp(m.y, -b.xyz, b.xyz);
  if (finite(m.z)) p.z = clamp(m.z, -b.xyz, b.xyz);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
}

// `loadout` { tool, toolOut, carry, carryVariant, held }: catalog ids ("" = none).
export function applyLoadout(p: PlayerState, msg: unknown): void {
  const m = obj(msg);
  if (!m) return;
  for (const key of ["tool", "carry", "carryVariant", "held"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  if (typeof m.toolOut === "boolean") p.toolOut = m.toolOut;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = obj(msg)?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}

// `emote` { id }: a Bloxity emote this player picked; the others play it too.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = obj(msg)?.id;
  if (typeof id !== "string" || !EMOTE_PATTERN.test(id)) return;
  p.emote = id;
  p.emoteSeq = (p.emoteSeq + 1) & 0xffff;
}

// One bay of a garage: null (empty), a block { k: "b", t, v?, hp, max } or a car
// { k: "c", t, r, n, l, lv, b, v? } (theme, variant, rarity, name, look, level, base income).
function bay(v: unknown): Record<string, unknown> | null {
  const m = obj(v);
  if (!m || !isId(m.t)) return null;
  const variant = isId(m.v) ? { v: m.v } : {};
  if (m.k === "b") {
    const max = finite(m.max) ? clamp(m.max, 1, MONEY_MAX) : 1;
    const hp = finite(m.hp) ? clamp(m.hp, 0, max) : max;
    return { k: "b", t: m.t, hp, max, ...variant };
  }
  if (m.k === "c" && isId(m.r) && isName(m.n) && isId(m.l)) {
    const lv = Number.isInteger(m.lv) ? clamp(m.lv as number, 1, LEVEL_MAX) : 1;
    const b = finite(m.b) ? clamp(m.b, 0, MONEY_MAX) : 0;
    return { k: "c", t: m.t, r: m.r, n: m.n, l: m.l, lv, b, ...variant };
  }
  return null;
}

// `base` { lvl, unl, inc, bays }: conveyor upgrade level, bought bays, income ($/s) and what stands
// in each bay. Stored re-serialised (only the shape above survives); a malformed one is ignored.
export function applyBase(p: PlayerState, msg: unknown): void {
  const m = obj(msg);
  if (!m || !Array.isArray(m.bays)) return;
  const out = {
    lvl: Number.isInteger(m.lvl) ? clamp(m.lvl as number, 0, CONVEYOR_LEVEL_MAX) : 0,
    unl: Array.isArray(m.unl) ? [...new Set(m.unl.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < BAYS_MAX))] : [],
    inc: finite(m.inc) ? clamp(m.inc, 0, MONEY_MAX) : 0,
    bays: m.bays.slice(0, BAYS_MAX).map(bay),
  };
  const json = JSON.stringify(out);
  if (json.length <= BASE_MAX_LEN) p.base = json;
}
