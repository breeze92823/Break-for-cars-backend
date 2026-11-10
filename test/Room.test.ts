import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { PLOT_COUNT, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("world room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("holds six players, one garage each", async () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, 6);
    assert.strictEqual(PLOT_COUNT, ROOM_MAX_CLIENTS);
    const room = await colyseus.createRoom<WorldState>("world", {});
    assert.strictEqual(room.maxClients, 6);
    const clients = [];
    for (let i = 0; i < 6; i++) clients.push(await colyseus.connectTo(room, { username: `P${i}` }));
    await sleep(50);
    const plots = clients.map((c) => room.state.players.get(c.sessionId)!.plot).sort();
    assert.deepStrictEqual(plots, [0, 1, 2, 3, 4, 5]);
    await assert.rejects(colyseus.connectTo(room, { username: "P7" }), "a seventh player is turned away");
  });

  it("keeps the garage a player asks for when free, else the lowest free one", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { plot: 1 });
    const b = await colyseus.connectTo(room, { plot: 1 });
    const c = await colyseus.connectTo(room, { plot: 4 });
    const d = await colyseus.connectTo(room, { plot: 99 });
    await sleep(50);
    const plot = (s: string) => room.state.players.get(s)!.plot;
    assert.strictEqual(plot(a.sessionId), 1);
    assert.strictEqual(plot(b.sessionId), 0, "taken: the lowest free one");
    assert.strictEqual(plot(c.sessionId), 4);
    assert.strictEqual(plot(d.sessionId), 2, "out of range: the lowest free one");

    await a.leave(true);
    await sleep(50);
    const e = await colyseus.connectTo(room, { plot: 1 });
    await sleep(50);
    assert.strictEqual(plot(e.sessionId), 1, "a garage frees up when its owner leaves");
  });

  it("never trusts a client's id: guests without a verified token", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "someone-else", username: "Ann" });
    const b = await colyseus.connectTo(room, { devId: "dev-abc", username: "Dev" });
    await sleep(50);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(pa.uid, "", "a sent user id is ignored");
    assert.strictEqual(pa.signedIn, false);
    assert.strictEqual(pb.uid, "dev-abc", "a dev id counts off production (local server)");
  });

  it("relays pose, hands, swings, emotes and the garage, bounded", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann", pfp: "javascript:alert(1)" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.pfp, "", "only http(s) pictures are relayed");

    a.send("pose", { x: 1.5, y: 99999, z: -3, yaw: 7, speed: -2 });
    a.send("loadout", { tool: "diamond", toolOut: false, carry: "gold", carryVariant: "Golden", held: "<script>" });
    a.send("swing", {});
    a.send("swing", {});
    a.send("emote", { id: "000000000000000000000e01" });
    a.send("base", {
      lvl: 3,
      unl: [9, 9, 42, "x"],
      inc: 12.5,
      bays: [
        { k: "b", t: "cyan", hp: 5000, max: 4000, v: "Golden" },
        { k: "c", t: "gold", r: "Common", n: "Pebble", l: "blueCoupe", lv: 3.5, b: 3.2 },
        { k: "c", t: "gold", r: "Common", n: "<b>bad</b>", l: "blueCoupe", lv: 1, b: 1 },
        null,
        "junk",
      ],
    });
    await sleep(50);
    assert.strictEqual(p.x, 1.5);
    assert.strictEqual(p.y, 2000, "clamped");
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "wrapped");
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.tool, "diamond");
    assert.strictEqual(p.toolOut, false);
    assert.strictEqual(p.carry, "gold");
    assert.strictEqual(p.carryVariant, "Golden");
    assert.strictEqual(p.held, "", "a non-id is dropped");
    assert.strictEqual(p.swing, 2);
    assert.strictEqual(p.emote, "000000000000000000000e01");
    assert.strictEqual(p.emoteSeq, 1);
    const base = JSON.parse(p.base);
    assert.strictEqual(base.lvl, 3);
    assert.deepStrictEqual(base.unl, [9]);
    assert.strictEqual(base.inc, 12.5);
    assert.deepStrictEqual(base.bays[0], { k: "b", t: "cyan", hp: 4000, max: 4000, v: "Golden" });
    assert.deepStrictEqual(base.bays[1], { k: "c", t: "gold", r: "Common", n: "Pebble", l: "blueCoupe", lv: 1, b: 3.2 });
    assert.strictEqual(base.bays[2], null, "a bad name drops the bay");
    assert.strictEqual(base.bays[4], null);

    a.send("base", { bays: "nope" });
    await sleep(50);
    assert.strictEqual(JSON.parse(p.base).lvl, 3, "a malformed garage is ignored");
  });

  it("answers an ad reward without a valid token with a no", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    const answer = new Promise<{ ok: boolean; reason?: string }>((resolve) => a.onMessage("adReward", resolve));
    a.send("adReward", { rewardToken: "" });
    const r = await answer;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "invalid");
  });
});
