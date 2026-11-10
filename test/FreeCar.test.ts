import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { FREE_CAR_SECONDS } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __resetFreeCarForTest, cleanSeconds, loadFreeCar, savePlayed } from "../src/freeCar.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type FreeCar = { tracked: boolean; played?: number; claimed?: boolean; need?: number };
type Claim = { ok: boolean; reason?: string; played?: number };

// No MONGODB_URI in tests: freeCar.ts keeps the records in memory, same contract as Mongo.
describe("free car", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetFreeCarForTest();
  });

  async function join(devId?: string) {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, devId ? { devId } : {});
    const msg = <T>(type: string) => new Promise<T>((resolve) => c.onMessage(type, resolve));
    return { c, msg };
  }

  it("bounds a client's seconds", () => {
    assert.strictEqual(cleanSeconds(12.9), 12);
    assert.strictEqual(cleanSeconds(-5), 0);
    assert.strictEqual(cleanSeconds(1e9), FREE_CAR_SECONDS);
    assert.strictEqual(cleanSeconds("60"), null);
  });

  it("tells a guest it is not tracked and refuses its claim", async () => {
    const { c, msg } = await join();
    const sync = msg<FreeCar>("freeCar");
    c.send("freeCarSync", { played: FREE_CAR_SECONDS, claimed: false });
    assert.deepStrictEqual(await sync, { tracked: false });
    const claim = msg<Claim>("freeCarClaim");
    c.send("freeCarClaim", {});
    assert.strictEqual((await claim).reason, "guest");
  });

  it("refuses a claim before the play time is reached", async () => {
    const { c, msg } = await join("dev-free1");
    const sync = msg<FreeCar>("freeCar");
    c.send("freeCarSync", { played: 60, claimed: false });
    const s = await sync;
    assert.strictEqual(s.tracked, true);
    assert.strictEqual(s.need, FREE_CAR_SECONDS);
    assert.ok(s.played! >= 60 && s.played! < 70, "a new account starts from the browser's count");
    const claim = msg<Claim>("freeCarClaim");
    c.send("freeCarClaim", {});
    assert.strictEqual((await claim).reason, "early");
  });

  it("gives the car once per account, then remembers it on any device", async () => {
    await savePlayed("dev-free2", FREE_CAR_SECONDS); // played 30 min before
    const first = await join("dev-free2");
    const sync = first.msg<FreeCar>("freeCar");
    first.c.send("freeCarSync", { played: 0, claimed: false });
    const s = await sync;
    assert.ok(s.played! >= FREE_CAR_SECONDS, "the stored time wins over a fresh browser's 0");
    assert.strictEqual(s.claimed, false);

    const claims: Claim[] = [];
    first.c.onMessage("freeCarClaim", (m: Claim) => claims.push(m));
    first.c.send("freeCarClaim", {});
    first.c.send("freeCarClaim", {}); // a double click claims once
    await sleep(100);
    assert.strictEqual(claims.filter((m) => m.ok).length, 1, "exactly one claim is accepted");
    assert.deepStrictEqual(claims.find((m) => !m.ok), { ok: false, reason: "claimed" });
    await first.c.leave(true);
    await sleep(50);

    const again = await join("dev-free2");
    const sync2 = again.msg<FreeCar>("freeCar");
    again.c.send("freeCarSync", { played: 0, claimed: false });
    assert.strictEqual((await sync2).claimed, true);
    assert.strictEqual((await loadFreeCar("dev-free2"))?.claimed, true);
  });

  it("saves the counted play time when the player leaves", async () => {
    const { c, msg } = await join("dev-free3");
    const sync = msg<FreeCar>("freeCar");
    c.send("freeCarSync", { played: 100, claimed: false });
    await sync;
    await sleep(1100);
    await c.leave(true);
    await sleep(80);
    const rec = await loadFreeCar("dev-free3");
    assert.ok(rec && rec.played >= 101, `stored ${rec?.played}`);
  });
});
