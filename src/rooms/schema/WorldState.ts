import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room and what the others draw of them. The game is client-
// authoritative and keeps progress in the browser; this is presence only (presence.ts bounds it).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    uid: t.string().default(""), // the Bloxity id the server verified from the player's token ("" = guest): chat bubbles
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a verified Bloxity id
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    plot: t.int8().default(-1), // the garage this player owns in this room, 0..PLOT_COUNT-1
    // Pose (`pose`, ~10/s): feet position in world metres, heading (rad), ground speed (m/s).
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0),
    speed: t.float32().default(0),
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    // Hands (`loadout`): the equipped pickaxe id and whether it is in hand, the block being carried
    // (BLOCK_THEMES key + event variant) and the car model held from the hotbar (CARS key).
    tool: t.string().default(""),
    toolOut: t.boolean().default(true),
    carry: t.string().default(""),
    carryVariant: t.string().default(""),
    held: t.string().default(""),
    swing: t.uint16().default(0), // bumped on every pickaxe swing: the others play it
    emote: t.string().default(""), // the Bloxity emote last played...
    emoteSeq: t.uint16().default(0), // ...bumped each time, so a repeat of the same one is a change
    base: t.string().default(""), // the garage as the others draw it (JSON, presence.ts applyBase)
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
