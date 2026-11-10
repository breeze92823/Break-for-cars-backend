import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { TUTORIAL_DONE_STEP } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __resetTutorialForTest, cleanStep, loadTutorial } from "../src/tutorial.js";
import { testServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// No MONGODB_URI in tests: tutorial.ts keeps the steps in memory, same contract as Mongo.
describe("tutorial progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetTutorialForTest();
  });

  it("bounds a client's step", () => {
    assert.strictEqual(cleanStep(2.7), 2);
    assert.strictEqual(cleanStep(-4), 0);
    assert.strictEqual(cleanStep(99), TUTORIAL_DONE_STEP);
    assert.strictEqual(cleanStep("3"), null);
    assert.strictEqual(cleanStep(NaN), null);
  });

  it("saves a verified player's step and sends it back on the next join", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const first = await colyseus.connectTo(room, { devId: "dev-tut1" });
    const hello = new Promise<{ step: number }>((resolve) => first.onMessage("tutorial", resolve));
    first.send("tutorialSync", { step: 0 });
    assert.strictEqual((await hello).step, 0, "a new account starts at step 0");

    first.send("tutorial", { step: 2 });
    first.send("tutorial", { step: 1 }); // late / replayed: never lowers it
    await sleep(80);
    assert.strictEqual(await loadTutorial("dev-tut1"), 2);
    await first.leave(true);
    await sleep(50);

    // A fresh browser (reports 0) resumes from the stored step (the empty room closed: a new one).
    const room2 = await colyseus.createRoom<WorldState>("world", {});
    const again = await colyseus.connectTo(room2, { devId: "dev-tut1" });
    const resumedP = new Promise<{ step: number }>((resolve) => again.onMessage("tutorial", resolve));
    again.send("tutorialSync", { step: 0 });
    const resumed = await resumedP;
    assert.strictEqual(resumed.step, 2);
  });

  it("keeps the further of the stored and the reported step", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { devId: "dev-tut2" });
    const stepP = new Promise<{ step: number }>((resolve) => a.onMessage("tutorial", resolve));
    a.send("tutorialSync", { step: 4 });
    const step = await stepP;
    assert.strictEqual(step.step, 4, "an older save on this browser counts");
    assert.strictEqual(await loadTutorial("dev-tut2"), 4, "and is stored for the account");
  });

  it("stores nothing for a guest", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const g = await colyseus.connectTo(room, {});
    let answered = false;
    g.onMessage("tutorial", () => (answered = true));
    g.send("tutorialSync", { step: 3 });
    g.send("tutorial", { step: 4 });
    await sleep(80);
    assert.strictEqual(answered, false, "a guest's progress stays in its browser");
    assert.strictEqual(await loadTutorial(""), null);
  });
});
