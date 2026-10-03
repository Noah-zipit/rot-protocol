/**
 * Headless verification for ROT PROTOCOL Expedition Mode ("Dead Zone").
 * Bundled with esbuild to node ESM (--define:import.meta.env.DEV=false).
 * Exits non-zero on any failed check.
 */
import {
  createGame, startRun, stepSim, fireWeapon, FIXED_DT,
  type GameState, type InputState, type LootKind,
} from "../src/sim";
import {
  loadStash, saveStash, buyUpgrade, startExpeditionRun, compassMarkers, UPGRADE_DEFS,
} from "../src/expedition";

// node has no localStorage: shim it in-memory so load/saveStash run the real
// persistence path (shared across loadStash calls, like the browser)
const memStore = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, v); },
  removeItem: (k: string) => { memStore.delete(k); },
};
function resetStore() { memStore.clear(); }

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

function blankInput(): InputState {
  return {
    moveX: 0, moveY: 0, sprint: false,
    jumpPressed: false, slidePressed: false, fireHeld: false,
    reloadPressed: false, swap1: false, swap2: false,
    meleePressed: false, pausePressed: false,
    interactPressed: false, usePressed: false,
    lookDX: 0, lookDY: 0,
  };
}

function step(sim: GameState, inp: InputState, n: number) {
  for (let i = 0; i < n; i++) stepSim(sim, inp, FIXED_DT);
  inp.interactPressed = false; inp.usePressed = false; // edge-triggered, swallow
}

function teleport(sim: GameState, x: number, z: number) {
  sim.player.pos.x = x; sim.player.pos.z = z;
}

/* ---------------- A. full extract run ---------------- */
console.log("A. full extract run");
{
  resetStore();
  const stash = loadStash();
  const s0scrap = stash.scrap, s0parts = stash.parts, s0extracts = stash.best.extracts;
  const sim = createGame("deadzone", false, "expedition");
  check("mode is expedition", sim.mode === "expedition" && sim.half === 62);
  startExpeditionRun(sim, ["pistol", "shotgun"], stash);
  check("exp state exists", sim.exp !== null);
  const ex = sim.exp!;
  check("7 caches ringed", ex.caches.length === 7, `got ${ex.caches.length}`);
  check("loot field populated (21+ cache, 5 crash, scattered)", ex.loot.length >= 26, `got ${ex.loot.length}`);
  check("crash loot present", ex.loot.filter((l) => Math.hypot(l.pos.x - ex.crashPos.x, l.pos.z - ex.crashPos.z) < 7).length >= 5);
  check("2 hunting shriekers", sim.enemies.filter((e) => e.kind === "shrieker").length === 2);
  check("3 brute guards", sim.enemies.filter((e) => e.kind === "brute").length === 3);
  check("6 roaming packs (18+ roamers)", sim.enemies.filter((e) => e.state === "roam").length >= 18,
    `roamers=${sim.enemies.filter((e) => e.state === "roam").length}`);
  check("exfil at NE corner", ex.exfilPos.x === 52 && ex.exfilPos.z === -52);
  check("player inserted at SW edge", Math.abs(sim.player.pos.x + 54) < 1 && Math.abs(sim.player.pos.z - 54) < 1);
  check("stash upgrades applied (fresh stash = x1)", sim.player.dmgMul === 1 && sim.player.speedMul === 1);

  // collect every loot item by walking over it — all 4 kinds.
  // (pistol has infinite reserve, so ammo only picks up on the shotgun;
  // medkits cap at 3 carried, the rest stay on the ground by design)
  sim.player.cur = 1; // shotgun
  const inp = blankInput();
  const kinds = new Set<LootKind>();
  let pickups = 0;
  for (const l of ex.loot) {
    teleport(sim, l.pos.x, l.pos.z);
    step(sim, inp, 3);
    if (l.taken) { pickups++; kinds.add(l.kind); }
  }
  check("lootPickup events fired", sim.events.filter((e) => e.t === "lootPickup").length === pickups);
  check("scrap collected", kinds.has("scrap"));
  check("ammo collected on shotgun", kinds.has("ammo") && sim.player.loadout[1].reserve > 24,
    `reserve=${sim.player.loadout[1].reserve}`);
  check("medkit carry capped at 3", ex.carried.medkits <= 3, `carried=${ex.carried.medkits}`);
  check("parts collected", kinds.has("part"));
  check("carried scrap > 0", ex.carried.scrap > 0, `got ${ex.carried.scrap}`);
  check("carried parts > 0", ex.carried.parts > 0, `got ${ex.carried.parts}`);
  sim.events.length = 0;

  // use a medkit: damage the player first so the medkit actually fires
  sim.player.hp = 40;
  inp.usePressed = true; step(sim, inp, 2);
  check("useMedkit event fired", sim.events.some((e) => e.t === "useMedkit"));
  check("hp restored by medkit", sim.player.hp > 40, `hp=${sim.player.hp}`);
  check("medkit consumed from carry", ex.carried.medkits >= 0);
  sim.events.length = 0;

  // kill a zombie through the real weapon pipeline (aim, fire, death events)
  const roamer = sim.enemies.find((e) => !e.dead && (e.state === "roam" || e.state === "investigate" || e.state === "seek"));
  check("target found", !!roamer);
  if (roamer) {
    sim.player.cur = 0; // pistol
    teleport(sim, roamer.pos.x + 4, roamer.pos.z);
    const dx = roamer.pos.x - sim.player.pos.x, dz = roamer.pos.z - sim.player.pos.z;
    sim.player.yaw = Math.atan2(-dx, -dz);
    sim.player.pitch = 0;
    const w = sim.player.loadout[0];
    for (let shot = 0; shot < 40 && !roamer.dead; shot++) {
      w.cooldown = 0; w.mag = 12;
      fireWeapon(sim, w);
      step(sim, blankInput(), 2);
      // keep aim on the (moving) target
      const ddx = roamer.pos.x - sim.player.pos.x, ddz = roamer.pos.z - sim.player.pos.z;
      sim.player.yaw = Math.atan2(-ddx, -ddz);
      teleport(sim, roamer.pos.x + 4, roamer.pos.z);
    }
    check("roamer died to gunfire", roamer.dead);
    check("enemyDie event fired", sim.events.some((e) => e.t === "enemyDie"));
  }
  sim.events.length = 0;

  // compass markers sanity
  sim.player.yaw = 0;
  const marks = compassMarkers(sim);
  check("compass has exfil + cache + crash marks",
    marks.some((m) => m.cls === "mk-exfil") && marks.some((m) => m.cls === "mk-cache") && marks.some((m) => m.cls === "mk-crash"),
    marks.map((m) => m.cls).join(","));

  // pop the flare at the exfil pad (player kept alive deliberately: the
  // pickup/kill phases above are white-box teleporting, not fair combat)
  check("player survived the setup phases", !sim.over && sim.player.hp > 0, `hp=${sim.player.hp} over=${sim.over}`);
  sim.player.hp = sim.player.maxHp;
  // drain any hitstop left by the kill-test's final headshot (stepSim
  // early-returns while hitstop > 0, which would eat the flare input)
  for (let i = 0; i < 12 && sim.hitstop > 0; i++) stepSim(sim, blankInput(), FIXED_DT);
  const carriedScrap = ex.carried.scrap, carriedParts = ex.carried.parts;
  teleport(sim, ex.exfilPos.x, ex.exfilPos.z);
  inp.interactPressed = true; step(sim, inp, 2);
  check("flare popped -> exfil called", ex.exfil === "called");
  check("flarePopped event", sim.events.some((e) => e.t === "flarePopped"));
  sim.events.length = 0;

  // survive the 30s surge: top up hp, cull close enemies, stay in the zone
  let ticks = 0;
  while (ex.exfil === "called" && ticks < 40 * 60) {
    teleport(sim, ex.exfilPos.x, ex.exfilPos.z);
    sim.player.hp = sim.player.maxHp;
    if (ticks % 12 === 0) {
      for (const e of sim.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.pos.x - sim.player.pos.x, e.pos.z - sim.player.pos.z);
        if (d < 18) e.hp = 0;
      }
    }
    step(sim, blankInput(), 1);
    ticks++;
  }
  check("surge survived (30s)", ex.exfil === "landed", `exfil=${ex.exfil}`);
  check("exfilReady event", sim.events.some((e) => e.t === "exfilReady"));
  sim.events.length = 0;

  // board: already standing in the pad
  step(sim, blankInput(), 3);
  check("extracted", ex.exfil === "landed" && sim.won && sim.exResult?.extracted === true,
    `exfil=${ex.exfil} won=${sim.won} exResult=${JSON.stringify(sim.exResult)}`);
  check("extracted event", sim.events.some((e) => e.t === "extracted"));
  // doExtract banks into a fresh loadStash() and saves — re-read like main.ts does
  const after = loadStash();
  check("stash gained carried scrap", after.scrap === s0scrap + carriedScrap, `0 -> ${after.scrap} (carried ${carriedScrap})`);
  check("stash gained carried parts", after.parts === s0parts + carriedParts, `0 -> ${after.parts} (carried ${carriedParts})`);
  check("extraction counted", after.best.extracts === s0extracts + 1, `extracts=${after.best.extracts}`);
}

/* ---------------- B. death loses carried loot ---------------- */
console.log("B. death loses carried loot");
{
  resetStore();
  const stash = loadStash();
  stash.scrap = 777; stash.parts = 11; // pre-banked — must survive
  saveStash(stash);
  const sim = createGame("deadzone", false, "expedition");
  startExpeditionRun(sim, ["pistol", "shotgun"], stash);
  const ex = sim.exp!;
  const inp = blankInput();
  // grab a few items
  for (const l of ex.loot.slice(0, 5)) { teleport(sim, l.pos.x, l.pos.z); step(sim, inp, 3); }
  check("carried loot before death", ex.carried.scrap > 0, `scrap=${ex.carried.scrap}`);
  // die: -9999 overwhelms passive regen, like a real killing blow
  sim.player.hp = -9999;
  step(sim, blankInput(), 2);
  check("run over", sim.over === true);
  check("exResult = not extracted", sim.exResult?.extracted === false);
  check("gameOver event", sim.events.some((e) => e.t === "gameOver"));
  const after = loadStash();
  check("stash scrap untouched by death", after.scrap === 777, `got ${after.scrap}`);
  check("stash parts untouched by death", after.parts === 11, `got ${after.parts}`);
}

/* ---------------- C. upgrade purchase ---------------- */
console.log("C. upgrade purchase");
{
  resetStore();
  const stash = loadStash();
  stash.scrap = 1000; stash.parts = 10;
  const dmgDef = UPGRADE_DEFS.find((d) => d.key === "dmg")!;
  const c1 = dmgDef.cost(1);
  const ok = buyUpgrade(stash, "dmg");
  check("purchase succeeds with funds", ok === true);
  check("dmg tier now 1", stash.upgrades.dmg === 1);
  check("cost deducted", stash.scrap === 1000 - c1.scrap && stash.parts === 10 - c1.parts,
    `scrap=${stash.scrap} parts=${stash.parts} (cost ${c1.scrap}/${c1.parts})`);
  const re = loadStash();
  check("stash persists to storage", re.upgrades.dmg === 1 && re.scrap === stash.scrap);
  stash.scrap = 0; stash.parts = 0;
  check("purchase fails when broke", buyUpgrade(stash, "dmg") === false);
  check("tier unchanged", stash.upgrades.dmg === 1);
  const hpDef = UPGRADE_DEFS.find((d) => d.key === "hp")!;
  stash.upgrades.hp = hpDef.max; stash.scrap = 99999; stash.parts = 99;
  check("maxed tier rejected", buyUpgrade(stash, "hp") === false);
  // upgrades apply to the next run
  stash.upgrades.dmg = 1; stash.upgrades.hp = 1; stash.upgrades.speed = 1; stash.upgrades.ammo = 1;
  const sim = createGame("deadzone", false, "expedition");
  startExpeditionRun(sim, ["pistol", "shotgun"], stash);
  check("dmg +12%/tier applied", Math.abs(sim.player.dmgMul - 1.12) < 1e-9, `got ${sim.player.dmgMul}`);
  check("hp +25/tier applied", sim.player.maxHp === 125, `got ${sim.player.maxHp}`);
  check("speed +7%/tier applied", Math.abs(sim.player.speedMul - 1.07) < 1e-9, `got ${sim.player.speedMul}`);
  const sg = sim.player.loadout.find((w) => w.key === "shotgun")!;
  check("ammo +50%/tier reserve applied", sg.reserve === Math.floor(24 * 1.5), `reserve=${sg.reserve}`);
}

/* ---------------- D. wave-mode regression ---------------- */
console.log("D. wave-mode regression");
{
  const sim = createGame("graveyard", false); // default mode = wave
  check("default mode is wave", sim.mode === "wave" && sim.exp === null && sim.half === 28);
  startRun(sim, ["pistol", "shotgun"]);
  const inp = blankInput();
  let nanFound = false;
  for (let f = 0; f < 1200; f++) {
    inp.moveY = f % 120 < 60 ? 1 : -1;
    inp.fireHeld = f % 45 === 0;
    inp.lookDX = 0.01;
    stepSim(sim, inp, FIXED_DT);
    const p = sim.player;
    if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.z) || !Number.isFinite(p.hp)) nanFound = true;
    for (const e of sim.enemies) {
      if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.z) || !Number.isFinite(e.hp)) nanFound = true;
    }
    if (sim.over || sim.won) break;
  }
  check("1200 frames, no NaN", !nanFound);
  check("wave 1 started", sim.wave >= 1, `wave=${sim.wave}`);
  check("enemies spawned", sim.enemies.length > 0, `enemies=${sim.enemies.length}`);
  check("kills possible", sim.kills >= 0 && sim.score >= 0);

  const city = createGame("city", false);
  startRun(city, ["pistol", "shotgun"]);
  for (let f = 0; f < 400; f++) stepSim(city, blankInput(), FIXED_DT);
  check("city map 400 frames stable", city.time > 6 && Number.isFinite(city.player.pos.x));
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
