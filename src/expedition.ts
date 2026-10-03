/**
 * ROT PROTOCOL — Expedition Mode ("Dead Zone"). DMZ-style loop:
 * INSERT (helicopter drop at the map edge) -> LOOT (scrap, medkits, ammo,
 * weapon parts) -> EXFIL (flare + 30s surge + board the chopper) ->
 * STASH (persistent, spend on upgrades). DEATH = lose all carried loot.
 *
 * Sim-only: rendering reads GameState like the wave mode does.
 */
import {
  startRun,
  spawnEnemyAt,
  type GameState, type EnemyKind, type WeaponKey, type LootItem, type LootKind,
  type UpgradeLevels, type Vec3,
  expeditionHooks,
} from "./sim";
import type { InputState } from "./input";

// ---------------- stash (localStorage, survives death) ----------------

export interface Stash {
  scrap: number; parts: number;
  upgrades: UpgradeLevels;
  best: { scrap: number; extracts: number; kills: number };
}

const STASH_KEY = "rp-expedition-stash";

export function defaultStash(): Stash {
  return {
    scrap: 0, parts: 0,
    upgrades: { dmg: 0, hp: 0, speed: 0, ammo: 0 },
    best: { scrap: 0, extracts: 0, kills: 0 },
  };
}

export function loadStash(): Stash {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return defaultStash();
    const p = JSON.parse(raw) as Partial<Stash>;
    const d = defaultStash();
    return {
      scrap: Math.max(0, Math.floor(p.scrap ?? 0)),
      parts: Math.max(0, Math.floor(p.parts ?? 0)),
      upgrades: { ...d.upgrades, ...(p.upgrades ?? {}) },
      best: { ...d.best, ...(p.best ?? {}) },
    };
  } catch { return defaultStash(); }
}

export function saveStash(s: Stash) {
  try { localStorage.setItem(STASH_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

// ---------------- upgrades ----------------

export interface UpgradeDef {
  key: keyof UpgradeLevels; name: string; desc: string; max: number;
  cost: (tier: number) => { scrap: number; parts: number }; // tier = next level, 1-based
  effect: (tier: number) => string;
}

export const UPGRADE_DEFS: UpgradeDef[] = [
  {
    key: "dmg", name: "GUN DAMAGE", desc: "Every weapon hits harder", max: 5,
    cost: (t) => ({ scrap: 100 * t, parts: t }),
    effect: (t) => `+${t * 12}% damage`,
  },
  {
    key: "hp", name: "MAX HP", desc: "Survive bigger hits", max: 5,
    cost: (t) => ({ scrap: 75 * t, parts: 0 }),
    effect: (t) => `${100 + t * 25} max HP`,
  },
  {
    key: "speed", name: "MOVE SPEED", desc: "Outrun the horde", max: 3,
    cost: (t) => ({ scrap: 60 * t, parts: 0 }),
    effect: (t) => `+${t * 7}% move speed`,
  },
  {
    key: "ammo", name: "STARTING AMMO", desc: "Fatter reserves on insert", max: 3,
    cost: (t) => ({ scrap: 50 * t, parts: 0 }),
    effect: (t) => `+${t * 50}% reserve ammo`,
  },
];

/** Spend scrap/parts on an upgrade tier. Returns false when maxed or broke. */
export function buyUpgrade(stash: Stash, key: keyof UpgradeLevels): boolean {
  const def = UPGRADE_DEFS.find((d) => d.key === key);
  if (!def) return false;
  const cur = stash.upgrades[key];
  if (cur >= def.max) return false;
  const c = def.cost(cur + 1);
  if (stash.scrap < c.scrap || stash.parts < c.parts) return false;
  stash.scrap -= c.scrap;
  stash.parts -= c.parts;
  stash.upgrades[key] = cur + 1;
  saveStash(stash);
  return true;
}

// ---------------- run setup ----------------

const INSERTION = { x: -54, z: 54 };   // south-west edge (half = 62)
const EXFIL = { x: 52, z: -52 };       // north-east clearing

function makeRng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/**
 * Start an expedition run: insertion, loot field, roaming packs, cache
 * brutes, exfil point. Call AFTER createGame("deadzone", isTouch,
 * "expedition") — world.setMap("deadzone", s.obstacles, s.exp) follows.
 */
export function startExpeditionRun(
  s: GameState, loadout: WeaponKey[], stash: Stash, seed = (Math.random() * 1e9) | 0
) {
  // startRun applies stash upgrades (dmg/hp/speed/ammo) and clears exp
  startRun(s, loadout, stash.upgrades);
  const rnd = makeRng(seed);
  const H = s.half;

  // insertion: south-west edge, facing the zone center
  s.player.pos = { x: INSERTION.x, y: 0, z: INSERTION.z };
  s.player.yaw = Math.atan2(-(0 - INSERTION.x), -(0 - INSERTION.z));

  // crash site landmark: the r=3.0 obstacle from makeObstacles
  const crash = s.obstacles.find((o) => o.r >= 2.5 && o.r <= 3.5);
  const crashPos: Vec3 = crash ? { x: crash.x, y: 0, z: crash.z } : { x: 10, y: 0, z: 5 };

  // 7 supply caches on a rough ring; caches 0 and 3 are high-value (parts)
  const caches: Vec3[] = [];
  for (let i = 0; i < 7; i++) {
    let cx = 0, cz = 0;
    for (let tries = 0; tries < 10; tries++) {
      const a = (i / 7) * Math.PI * 2 + rnd() * 0.6;
      const r = 26 + rnd() * 18;
      cx = Math.cos(a) * r; cz = Math.sin(a) * r;
      const blocked = s.obstacles.some((o) => Math.hypot(o.x - cx, o.z - cz) < o.r + 2.2);
      if (!blocked) break;
    }
    caches.push({ x: cx, y: 0, z: cz });
    s.obstacles.push({ x: cx, z: cz, r: 0.8 }); // crate collider (world renders it)
  }

  // ---- loot field ----
  const loot: LootItem[] = [];
  let lid = 1;
  const drop = (kind: LootKind, x: number, z: number, amount: number) => {
    loot.push({ id: lid++, kind, pos: { x, y: 0, z }, amount, taken: false });
  };
  const scatter = (cx: number, cz: number, radius: number) => {
    const a = rnd() * Math.PI * 2, r = 1.6 + rnd() * radius;
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
  };
  caches.forEach((c, i) => {
    const hi = i === 0 || i === 3;
    const n = 3 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) {
      const q = scatter(c.x, c.z, 3);
      const roll = rnd();
      if (hi && k === 0) drop("part", q.x, q.z, 1);
      else if (roll < 0.45) drop("scrap", q.x, q.z, 10 + Math.floor(rnd() * 16));
      else if (roll < 0.65) drop("ammo", q.x, q.z, 20 + Math.floor(rnd() * 24));
      else if (roll < 0.85) drop("medkit", q.x, q.z, 1);
      else drop("scrap", q.x, q.z, 10 + Math.floor(rnd() * 16));
    }
  });
  // crash site: rich pickings
  for (let k = 0; k < 5; k++) {
    const q = scatter(crashPos.x, crashPos.z, 5);
    const roll = rnd();
    if (k === 0) drop("part", q.x, q.z, 1);
    else if (roll < 0.5) drop("scrap", q.x, q.z, 15 + Math.floor(rnd() * 20));
    else if (roll < 0.75) drop("ammo", q.x, q.z, 24 + Math.floor(rnd() * 24));
    else drop("medkit", q.x, q.z, 1);
  }
  // 12 scattered stashes across the zone
  for (let k = 0; k < 12; k++) {
    const x = (rnd() * 2 - 1) * (H - 10), z = (rnd() * 2 - 1) * (H - 10);
    if (Math.hypot(x - INSERTION.x, z - INSERTION.z) < 12) continue;
    if (Math.hypot(x - EXFIL.x, z - EXFIL.z) < 10) continue;
    const roll = rnd();
    if (roll < 0.5) drop("scrap", x, z, 8 + Math.floor(rnd() * 14));
    else if (roll < 0.75) drop("ammo", x, z, 16 + Math.floor(rnd() * 20));
    else drop("medkit", x, z, 1);
  }

  // ---- enemies ----
  // roaming packs: 6 packs of 3-5, kept away from the insertion point
  const packKinds: EnemyKind[] = ["shambler", "shambler", "runner", "rattler"];
  for (let pk = 0; pk < 6; pk++) {
    let px = 0, pz = 0;
    for (let tries = 0; tries < 12; tries++) {
      px = (rnd() * 2 - 1) * (H - 14);
      pz = (rnd() * 2 - 1) * (H - 14);
      if (Math.hypot(px - INSERTION.x, pz - INSERTION.z) > 26) break;
    }
    const n = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const kind = packKinds[Math.floor(rnd() * packKinds.length)];
      const e = spawnEnemyAt(s, kind, px + (rnd() * 2 - 1) * 6, pz + (rnd() * 2 - 1) * 6, {});
      e.state = "roam"; e.stateT = 0;
    }
  }
  // a shrieker pair that always hunts
  for (let k = 0; k < 2; k++) {
    const e = spawnEnemyAt(s, "shrieker", (rnd() * 2 - 1) * 30, (rnd() * 2 - 1) * 30, {});
    e.state = "seek"; e.stateT = 0;
  }
  // cache brutes: leashed guards on the two high-value caches + crash site
  for (const g of [caches[0], caches[3], crashPos]) {
    const e = spawnEnemyAt(s, "brute", g.x + 3, g.z + 2, { leash: 7, aggroR: 13 });
    e.state = "roam"; e.stateT = 0;
  }

  s.exp = {
    loot,
    carried: { scrap: 0, medkits: 0, parts: 0, ammoCollected: 0 },
    caches,
    crashPos,
    exfilPos: { x: EXFIL.x, y: 0, z: EXFIL.z },
    exfil: "idle", exfilT: 0, boardT: 0, surgeT: 0,
    startTime: s.time,
    lastShotT: -99, shotsSeen: 0,
    seed,
  };
}

// ---------------- the director (runs each tick for expedition mode) ----------------

export function stepExpedition(s: GameState, inp: InputState, dt: number) {
  const ex = s.exp!;
  const p = s.player;

  // gunfire noise: nearby roamers come to investigate
  if (s.shotsFired !== ex.shotsSeen) {
    ex.shotsSeen = s.shotsFired;
    ex.lastShotT = s.time;
    for (const e of s.enemies) {
      if (e.dead || e.state !== "roam") continue;
      if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < 30) {
        e.state = "investigate"; e.stateT = 0;
        e.roamTx = p.pos.x; e.roamTz = p.pos.z;
      }
    }
  }

  // loot pickup (walk-over)
  for (const l of ex.loot) {
    if (l.taken) continue;
    if (Math.hypot(l.pos.x - p.pos.x, l.pos.z - p.pos.z) > 1.5) continue;
    if (l.kind === "medkit" && ex.carried.medkits >= 3) continue; // full: leave it
    if (l.kind === "ammo") {
      const w = p.loadout[p.cur];
      if (!w || w.reserve < 0) continue; // infinite-reserve gun: leave it
      w.reserve += l.amount;
      ex.carried.ammoCollected += l.amount;
    } else if (l.kind === "scrap") ex.carried.scrap += l.amount;
    else if (l.kind === "part") ex.carried.parts += l.amount;
    else if (l.kind === "medkit") ex.carried.medkits += 1;
    l.taken = true;
    s.events.push({ t: "lootPickup", kind: l.kind, amount: l.amount });
  }

  // medkit use (H / MED button)
  if (inp.usePressed && ex.carried.medkits > 0 && p.hp < p.maxHp) {
    ex.carried.medkits--;
    const healed = Math.min(60, p.maxHp - p.hp);
    p.hp += healed;
    s.events.push({ t: "useMedkit", healed: Math.round(healed) });
  }

  // exfil interact (E / USE button): pop the flare inside the zone
  const dEx = Math.hypot(ex.exfilPos.x - p.pos.x, ex.exfilPos.z - p.pos.z);
  if (inp.interactPressed && dEx < 7 && ex.exfil === "idle") {
    ex.exfil = "called";
    ex.exfilT = 30;
    ex.surgeT = 1.5;
    s.events.push({ t: "flarePopped" });
  }

  if (ex.exfil === "called") {
    // leaving the zone cancels the call — the flare can be re-popped
    if (dEx > 11) {
      ex.exfil = "idle";
      s.events.push({ t: "exfilCancelled" });
    } else {
      ex.exfilT -= dt;
      // surge: escalating spawns while the flare burns
      ex.surgeT -= dt;
      if (ex.surgeT <= 0) {
        const alive = s.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
        if (alive < 12) {
          ex.surgeT = 2.2;
          const kinds: EnemyKind[] = ["shambler", "shambler", "runner", "rattler"];
          const n = ex.exfilT < 10 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, r = 16 + Math.random() * 8;
            const e = spawnEnemyAt(
              s, kinds[(Math.random() * kinds.length) | 0],
              p.pos.x + Math.cos(a) * r, p.pos.z + Math.sin(a) * r, {}
            );
            e.state = "seek"; e.stateT = 0; // surge hunters know where you are
          }
        } else {
          ex.surgeT = 2.2;
        }
      }
      if (ex.exfilT <= 0) {
        ex.exfil = "landed";
        ex.boardT = 25;
        s.events.push({ t: "exfilReady" });
      }
    }
  } else if (ex.exfil === "landed") {
    ex.boardT -= dt;
    if (dEx < 7) { doExtract(s); return; }
    if (ex.boardT <= 0) {
      ex.exfil = "idle";
      s.events.push({ t: "exfilCancelled" });
    }
  }
}

/** Bank carried loot into the persistent stash and end the run extracted. */
export function bankLoot(s: GameState, stash: Stash) {
  const ex = s.exp!;
  stash.scrap += ex.carried.scrap;
  stash.parts += ex.carried.parts;
  stash.best.extracts += 1;
  stash.best.scrap = Math.max(stash.best.scrap, ex.carried.scrap);
  stash.best.kills += s.kills;
  saveStash(stash);
}

function doExtract(s: GameState) {
  bankLoot(s, loadStash());
  s.exResult = { extracted: true };
  s.won = true; // reuses the victory flow; UI reads exResult for the summary
  s.events.push({ t: "extracted" });
}

// ---------------- compass ----------------

export interface CompassMark { rel: number; label: string; cls: string; }

/** Objective markers relative to the player's facing (radians, 0 = ahead). */
export function compassMarkers(s: GameState): CompassMark[] {
  const ex = s.exp;
  if (!ex) return [];
  const p = s.player;
  const out: CompassMark[] = [];
  const push = (x: number, z: number, label: string, cls: string) => {
    const dx = x - p.pos.x, dz = z - p.pos.z;
    const yawT = Math.atan2(-dx, -dz);
    let rel = yawT - p.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    out.push({ rel, label, cls });
  };
  push(ex.exfilPos.x, ex.exfilPos.z, "EXFIL", ex.exfil === "idle" ? "mk-exfil" : "mk-exfil-hot");
  for (const c of ex.caches) push(c.x, c.z, "CACHE", "mk-cache");
  push(ex.crashPos.x, ex.crashPos.z, "CRASH", "mk-crash");
  // nearby untaken loot + live threats (short-range only, to avoid clutter)
  for (const l of ex.loot) {
    if (l.taken) continue;
    if (Math.hypot(l.pos.x - p.pos.x, l.pos.z - p.pos.z) < 45) {
      push(l.pos.x, l.pos.z, "\u25C6", "mk-loot");
    }
  }
  for (const e of s.enemies) {
    if (e.dead) continue;
    if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < 30) {
      push(e.pos.x, e.pos.z, "!", "mk-threat");
    }
  }
  return out;
}

expeditionHooks.step = stepExpedition;
