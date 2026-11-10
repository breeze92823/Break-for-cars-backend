import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const car = (name: string) => ({ theme: "gold", rarity: "Rare", name, look: "solar", base: 12, level: 3, spent: 5 });

describe("trades", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("asks, accepts, relays offers, and swaps when both accept", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann" });
    const b = await colyseus.connectTo(room, { username: "Bob" });
    const got: Record<string, any[]> = { a: [], b: [] };
    for (const [k, c] of [["a", a], ["b", b]] as const) for (const t of ["tradeInvite", "tradeStart", "tradeState", "tradeDone", "tradeEnd"]) c.onMessage(t, (m: unknown) => got[k].push([t, m]));
    await sleep(50);
    a.send("tradeRequest", { to: b.sessionId });
    await sleep(50);
    assert.strictEqual(got.b[0][0], "tradeInvite");
    b.send("tradeReply", { from: a.sessionId, accept: true });
    await sleep(50);
    assert.strictEqual(got.a[0][0], "tradeStart");
    assert.strictEqual(got.b[0][0] === "tradeInvite" && got.b[1][0], "tradeStart");
    a.send("tradeOffer", { items: [car("Solar GT"), { bad: 1 }] });
    await sleep(50);
    assert.strictEqual((got.b.at(-1)![1] as any).theirs.length, 1, "malformed cars are dropped");
    a.send("tradeAccept", { accepted: true });
    b.send("tradeAccept", { accepted: true });
    await sleep(80);
    assert.strictEqual(got.b.at(-1)![0], "tradeDone");
    assert.strictEqual((got.b.at(-1)![1] as any).received[0].name, "Solar GT");
    assert.strictEqual((got.a.at(-1)![1] as any).received.length, 0);
  });

  it("an offer change clears accepts, and leaving ends the trade", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    let state: any = null;
    let ended: any = null;
    b.onMessage("tradeState", (m: unknown) => (state = m));
    b.onMessage("tradeEnd", (m: unknown) => (ended = m));
    a.onMessage("tradeStart", () => {});
    b.onMessage("tradeStart", () => {});
    await sleep(50);
    a.send("tradeRequest", { to: b.sessionId });
    await sleep(30);
    b.send("tradeReply", { from: a.sessionId, accept: true });
    await sleep(30);
    a.send("tradeOffer", { items: [car("A")] });
    b.send("tradeAccept", { accepted: true });
    await sleep(30);
    assert.strictEqual(state.meAccepted, true);
    a.send("tradeOffer", { items: [car("A"), car("B")] });
    await sleep(30);
    assert.strictEqual(state.meAccepted, false, "changing the offer clears accepts");
    await a.leave(true);
    await sleep(80);
    assert.strictEqual(ended?.reason, "left");
  });
});
