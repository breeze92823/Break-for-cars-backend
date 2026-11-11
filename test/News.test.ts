import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { NEWS_VERSION_MAX } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __resetNewsForTest, cleanVersion, loadNews } from "../src/news.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type News = { tracked: boolean; seen?: number };

// No MONGODB_URI in tests: news.ts keeps the versions in memory, same contract as Mongo.
describe("New Update window", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetNewsForTest();
  });

  it("bounds a client's version", () => {
    assert.strictEqual(cleanVersion(2.7), 2);
    assert.strictEqual(cleanVersion(-4), 0);
    assert.strictEqual(cleanVersion(1e12), NEWS_VERSION_MAX);
    assert.strictEqual(cleanVersion("1"), null);
    assert.strictEqual(cleanVersion(NaN), null);
  });

  it("remembers a verified player saw the update, on the next join from any browser", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const first = await colyseus.connectTo(room, { devId: "dev-news1" });
    const hello = new Promise<News>((resolve) => first.onMessage("news", resolve));
    first.send("newsSync", { seen: 0 });
    assert.deepStrictEqual(await hello, { tracked: true, seen: 0 }, "a new account has seen nothing");

    first.send("newsSeen", { version: 1 });
    first.send("newsSeen", { version: 0 }); // late / replayed: never lowers it
    await sleep(80);
    assert.strictEqual(await loadNews("dev-news1"), 1);
    await first.leave(true);
    await sleep(50);

    // A fresh browser (reports 0) is told the account already saw version 1.
    const room2 = await colyseus.createRoom<WorldState>("world", {});
    const again = await colyseus.connectTo(room2, { devId: "dev-news1" });
    const resumed = new Promise<News>((resolve) => again.onMessage("news", resolve));
    again.send("newsSync", { seen: 0 });
    assert.deepStrictEqual(await resumed, { tracked: true, seen: 1 });
  });

  it("keeps a version this browser saw before the account had one", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { devId: "dev-news2" });
    const reply = new Promise<News>((resolve) => a.onMessage("news", resolve));
    a.send("newsSync", { seen: 3 });
    assert.strictEqual((await reply).seen, 3);
    assert.strictEqual(await loadNews("dev-news2"), 3, "and stores it for the account");
  });

  it("tells a guest it is not tracked and stores nothing", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const g = await colyseus.connectTo(room, {});
    const reply = new Promise<News>((resolve) => g.onMessage("news", resolve));
    g.send("newsSync", { seen: 0 });
    assert.deepStrictEqual(await reply, { tracked: false });
    g.send("newsSeen", { version: 1 });
    await sleep(80);
    assert.strictEqual(await loadNews(""), null);
  });
});
