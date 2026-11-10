// Keep in step with the client's src/config.js (NET, LEADERBOARDS, PICKAXES, BLOCK_THEMES, CARS) by hand.

// The game slug registered on bloxity.io (the client's GAME_SLUG). Bloxity hosting also injects it
// as BLOXITY_GAME_ID; that wins when set.
export const GAME_SLUG = "break-for-cars";

// Players per room. Every player owns one of the room's PLOT_COUNT garages, so the two are equal.
// The deploy workflow sends this as Legion's `roomSize` (keep it 2-100 for Bloxity party play).
export const ROOM_MAX_CLIENTS = 6;
export const PLOT_COUNT = 6;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, and pose bounds
// (|x|, |y|, |z| in m; speed in m/s). The island is ~260 x 400 m.
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { xyz: 2000, speed: 200 };

// A player's garage as the others see it (presence.ts applyBase; client game.js baseSnapshot):
// relayed as JSON, never trusted for anything but drawing.
export const BASE_MAX_LEN = 12000;
// client BASE.slots x 2 per floor x (1 + BASE.floors.length) = 30 today; room for two more floors
export const BAYS_MAX = 50;
export const FLOORS_MAX = 4; // extra garage floors (client BASE.floors)
export const LEVEL_MAX = 1000; // car upgrade level (client GAME.upgrade.maxLevel is 50)
export const CONVEYOR_LEVEL_MAX = 64; // client CONVEYOR_UPGRADE.levels
export const MONEY_MAX = 1e33;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session
// (it keeps its garage meanwhile).
export const RECONNECT_SECONDS = 20;

// Bloxity's own boards (platformBoards.ts; the client's LEADERBOARDS in config.js declares the same
// ones): how often queued scores are reported and the most in one call.
export const PLATFORM_BOARD_EVERY_MS = 30 * 1000;
export const PLATFORM_BOARD_BATCH = 200;
export const PLATFORM_BOARDS = [
  { id: "cash", label: "Most Cash", order: "desc", mode: "latest", format: "compact", reset: "none" },
  { id: "income", label: "Total Income /s", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "playtime", label: "Play Time (min)", order: "desc", mode: "latest", format: "number", reset: "none" },
] as const;
export type BoardId = (typeof PLATFORM_BOARDS)[number]["id"];
// The most a `stats` message may claim (cash and income are the game's money; playtime minutes).
export const STAT_MAX = 1e30;
// How often a session's `stats` are accepted (the client sends them every NET.statsEvery s).
export const STATS_EVERY_MS = 10 * 1000;

// Rewarded ads (adReward.ts; client spin.js "Watch an ad"): a token is checked with Bloxity before the
// client adds the spin, at most once per AD_COOLDOWN_MS per session (server clock).
export const AD_TOKEN_MAX_LEN = 4096;
export const AD_COOLDOWN_MS = 3 * 60 * 1000;

// Catalog ids from the client's config.js (pickaxe ids, block themes, car looks, rarities, variants):
// plain slugs.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
// Car names from the client's CAR_ROSTER / DAILY / SPIN_WHEEL ("Solar GT").
export const NAME_PATTERN = /^[A-Za-z0-9 '.&!_-]{1,32}$/;
// `emote`: a Bloxity emote id (24-char catalogue ids, kept opaque).
export const EMOTE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Player-to-player trades (trades.ts; client game/trade.js): hotbar cars only, both sides must accept.
export const TRADE_SLOTS = 9; // cars per side (the window's 3 x 3 grid); the client's hotbar holds 7
export const TRADE_REACH_M = 15; // how close two players must be to start a trade (the client asks within ~5 m)
export const TRADE_INVITE_MS = 15 * 1000; // how long a request waits for an answer

// The new-player tutorial (tutorial.ts; client config.js TUTORIAL.steps): steps 0-4, then done.
export const TUTORIAL_DONE_STEP = 5;

// The HUD's free car (freeCar.ts; client config.js FREE_CAR.minutes): play this long (server clock,
// while connected) to claim it, once per verified account. Play time is saved this often meanwhile.
export const FREE_CAR_SECONDS = 30 * 60;
export const FREE_CAR_SAVE_MS = 60 * 1000;

// Ids the client makes in VITE_DEV_MODE (no SDK). Trusted only off production (a local server).
export const DEV_ID_PREFIX = "dev-";
