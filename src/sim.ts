/**
 * ROT PROTOCOL — fixed-timestep simulation (60Hz), decoupled from rendering.
 * All game state lives in plain data objects. Rendering only reads.
 * See README "Multiplayer notes" for the netcode-ready seams.
 */
import type { InputState } from "./input";

export type Vec3 = { x: number; y: number; z: number };
export type WeaponKey = "pistol" | "shotgun" | "smg" | "rifle";
export type EnemyKind =
  | "shambler" | "runner" | "brute"
  | "rattler" | "shrieker"
  | "rotking" | "ripper" | "broodmother";
export type MapKey = "graveyard" | "city";

export const FIXED_DT = 1 / 60;

export const IS_BOSS = (k: EnemyKind) => k === "rotking" || k === "ripper" || k === "broodmother";
export const IS_MINION = (k: EnemyKind) => !IS_BOSS(k);

// ---------------- tuning ----------------

export interface WeaponDef {
  name: string; damage: number; pellets: number; mag: number;
  reserve: number; // -1 = infinite
  rpm: number; reloadTime: number; spread: number; range: number;
  pierce: boolean; kick: number; desc: string;
}

export const WEAPONS: Record<WeaponKey, WeaponDef> = {
  pistol:  { name: "PISTOL",  damage: 34, pellets: 1, mag: 12, reserve: -1,  rpm: 320, reloadTime: 1.1, spread: 0.012, range: 60,  pierce: false, kick: 0.028, desc: "Reliable sidearm. Infinite reserve." },
  shotgun: { name: "SHOTGUN", damage: 16, pellets: 5, mag: 6,  reserve: 24,  rpm: 75,  reloadTime: 2.2, spread: 0.09,  range: 26,  pierce: false, kick: 0.09,  desc: "5-pellet spread. Tightens mid-slide." },
  smg:     { name: "SMG",     damage: 16, pellets: 1, mag: 32, reserve: 128, rpm: 800, reloadTime: 1.7, spread: 0.035, range: 42,  pierce: false, kick: 0.02,  desc: "Bullet hose. Low damage per round." },
  rifle:   { name: "RIFLE",   damage: 90, pellets: 1, mag: 5,  reserve: 20,  rpm: 55,  reloadTime: 2.5, spread: 0.004, range: 120, pierce: true,  kick: 0.07,  desc: "Slow, brutal, pierces the horde." },
};

export interface EnemyDef {
  name: string; hp: number; speed: number; damage: number;
  attackRange: number; windup: number; radius: number; height: number;
  score: number; scale: number; gltf: string; flying?: boolean;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  shambler:   { name: "SHAMBLER",     hp: 60,   speed: 2.2, damage: 12, attackRange: 1.7, windup: 0.45, radius: 0.45, height: 1.7,  score: 100,  scale: 1.0,  gltf: "enemies/Zombie_Basic.gltf" },
  runner:     { name: "RUNNER",       hp: 40,   speed: 4.6, damage: 8,  attackRange: 1.6, windup: 0.35, radius: 0.4,  height: 1.6,  score: 150,  scale: 1.0,  gltf: "enemies/Zombie_Ribcage.gltf" },
  brute:      { name: "BRUTE",        hp: 320,  speed: 1.5, damage: 30, attackRange: 2.1, windup: 0.6,  radius: 0.7,  height: 2.2,  score: 400,  scale: 1.25, gltf: "enemies/Zombie_Chubby.gltf" },
  rattler:    { name: "RATTLER",      hp: 30,   speed: 5.6, damage: 6,  attackRange: 1.5, windup: 0.3,  radius: 0.35, height: 1.7,  score: 175,  scale: 1.0,  gltf: "enemies/rattler.glb" },
  shrieker:   { name: "SHRIEKER",     hp: 45,   speed: 5.0, damage: 10, attackRange: 2.0, windup: 0.4,  radius: 0.5,  height: 0.9,  score: 200,  scale: 1.15, gltf: "enemies/shrieker.glb", flying: true },
  rotking:    { name: "THE ROT KING", hp: 2600, speed: 1.2, damage: 25, attackRange: 3.4, windup: 0.8,  radius: 1.4,  height: 3.0,  score: 2500, scale: 3.5,  gltf: "enemies/rotking.glb" },
  ripper:     { name: "THE RIPPER",   hp: 1700, speed: 3.4, damage: 30, attackRange: 2.2, windup: 0.5,  radius: 0.8,  height: 2.4,  score: 2000, scale: 1.55, gltf: "enemies/bluedemon.glb" },
  broodmother:{ name: "THE BROODMOTHER", hp: 2200, speed: 0.9, damage: 20, attackRange: 2.8, windup: 0.9, radius: 1.2, height: 2.8, score: 2200, scale: 2.0, gltf: "enemies/giant.glb" },
};

export const ARENA_HALF = 28;
export const MAX_WAVE = 10;

// ---------------- state ----------------

export interface WeaponState {
  key: WeaponKey; mag: number; reserve: number;
  cooldown: number; reloading: boolean; reloadT: number;
}

export interface PlayerState {
  pos: Vec3; vel: Vec3; yaw: number; pitch: number;
  hp: number; maxHp: number; lastDamageT: number;
  onGround: boolean;
  sliding: boolean; slideT: number; slideDir: Vec3;
  iframes: number;
  loadout: WeaponState[]; cur: number; drawT: number;
  meleeCd: number; meleeT: number;
  bobPhase: number; moveSpeed: number;
  eyeH: number; fov: number;
}

export type EnemyStateName =
  | "spawn" | "seek" | "windup" | "attack" | "die" | "slam"
  | "dashWindup" | "dashing" | "dashStun"
  | "swoopIn" | "swoopOut";

export interface Enemy {
  id: number; kind: EnemyKind;
  pos: Vec3; yaw: number;
  hp: number; maxHp: number;
  state: EnemyStateName; stateT: number;
  speed: number; walkPhase: number;
  attackCd: number; dashCd: number; flankPhase: number;
  dead: boolean; deadT: number;
  summoned: boolean; // rotking only: minion wave spawned
  summonT: number;   // broodmother only: minion spawn timer
  slamT: number;     // rotking only: telegraph timer, -1 = not slamming
  swoopT: number;    // shrieker only: swoop cooldown
  dashDir: Vec3;     // ripper only: locked dash direction
  knockMul: number;  // damage taken multiplier (ripper stunned = 1.5)
  variant: number;
}

export interface Obstacle { x: number; z: number; r: number; }

export type GameEvent =
  | { t: "shoot"; weapon: WeaponKey; pos: Vec3; dir: Vec3 }
  | { t: "hitEnemy"; pos: Vec3; headshot: boolean; killed: boolean }
  | { t: "shieldHit"; pos: Vec3 }
  | { t: "hitWorld"; pos: Vec3 }
  | { t: "enemyDie"; id: number; pos: Vec3; kind: EnemyKind; score: number; headshot: boolean }
  | { t: "playerHit"; dmg: number }
  | { t: "waveStart"; n: number; boss: EnemyKind | null; finale: boolean }
  | { t: "waveClear" }
  | { t: "victory" }
  | { t: "reloadStart"; weapon: WeaponKey }
  | { t: "reloadDone" }
  | { t: "dryFire" }
  | { t: "slideStart" }
  | { t: "melee" }
  | { t: "pickup"; kind: "ammo" | "health"; amount: number }
  | { t: "swap"; weapon: WeaponKey }
  | { t: "bossSlam"; pos: Vec3; radius: number }
  | { t: "bossSummon"; kind: EnemyKind }
  | { t: "dashTelegraph"; id: number; pos: Vec3; dir: Vec3 }
  | { t: "dashStun"; id: number }
  | { t: "gameOver" }
  | { t: "groan"; pos: Vec3 };

export interface GameState {
  map: MapKey;
  isTouch: boolean;
  player: PlayerState;
  enemies: Enemy[];
  obstacles: Obstacle[];
  wave: number;
  waveState: "breather" | "active";
  waveT: number;
  spawnQueue: EnemyKind[];
  spawnT: number;
  trickleT: number; // boss/finale waves: minion trickle timer
  score: number; kills: number;
  shotsFired: number; shotsHit: number;
  multiKills: number; multiT: number;
  events: GameEvent[];
  over: boolean;
  won: boolean;
  time: number;
  nextId: number;
  maxConcurrent: number;
  hitstop: number;
  bossIds: number[];
}

// ---------------- setup ----------------

export function makeObstacles(map: MapKey): Obstacle[] {
  const obs: Obstacle[] = [];
  let s = map === "graveyard" ? 12345 : 98765;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  if (map === "graveyard") {
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, r = 8 + rnd() * 16;
      obs.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: 0.55 });
    }
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2, r = 10 + rnd() * 14;
      obs.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: 0.45 });
    }
  } else {
    const blocks: Array<[number, number]> = [[-16, -16], [16, -16], [-16, 16], [16, 16], [0, -20], [0, 20]];
    for (const [bx, bz] of blocks) obs.push({ x: bx, z: bz, r: 5.2 });
    for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2, r = 6 + rnd() * 18;
      obs.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: 1.3 });
    }
  }
  return obs;
}

export function createGame(map: MapKey, isTouch: boolean): GameState {
  return {
    map, isTouch,
    player: {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, hp: 100, maxHp: 100, lastDamageT: -99,
      onGround: true, sliding: false, slideT: 0, slideDir: { x: 0, y: 0, z: 0 },
      iframes: 0, loadout: [], cur: 0, drawT: 0,
      meleeCd: 0, meleeT: 0, bobPhase: 0, moveSpeed: 0,
      eyeH: 1.62, fov: 75,
    },
    enemies: [],
    obstacles: makeObstacles(map),
    wave: 0, waveState: "breather", waveT: 2.5,
    spawnQueue: [], spawnT: 0, trickleT: 0,
    score: 0, kills: 0, shotsFired: 0, shotsHit: 0,
    multiKills: 0, multiT: -99,
    events: [], over: false, won: false, time: 0, nextId: 1,
    maxConcurrent: isTouch ? 8 : 14,
    hitstop: 0, bossIds: [],
  };
}

export function startRun(s: GameState, loadout: WeaponKey[]) {
  const p = s.player;
  p.pos = { x: 0, y: 0, z: 0 }; p.vel = { x: 0, y: 0, z: 0 };
  p.pitch = 0; p.hp = p.maxHp;
  // spawn facing the most open direction: pick the yaw with the farthest
  // obstacle inside a forward corridor, so the player never spawns staring
  // point-blank into a wall or car
  let bestYaw = 0, bestClear = -Infinity;
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    let minClear = Infinity;
    for (const o of s.obstacles) {
      const ox = o.x - p.pos.x, oz = o.z - p.pos.z;
      const along = ox * dx + oz * dz;
      if (along > 0.5) {
        const perp = Math.abs(ox * dz - oz * dx);
        if (perp < 3 + o.r) minClear = Math.min(minClear, along - o.r);
      }
    }
    if (minClear > bestClear) { bestClear = minClear; bestYaw = yaw; }
  }
  p.yaw = bestYaw;
  p.sliding = false; p.iframes = 0; p.meleeCd = 0;
  p.loadout = loadout.map((key) => {
    const d = WEAPONS[key];
    return { key, mag: d.mag, reserve: d.reserve, cooldown: 0, reloading: false, reloadT: 0 };
  });
  p.cur = 0; p.drawT = 0.4;
  s.enemies = []; s.wave = 0; s.waveState = "breather"; s.waveT = 2.0;
  s.spawnQueue = []; s.score = 0; s.kills = 0;
  s.shotsFired = 0; s.shotsHit = 0;
  s.multiKills = 0; s.over = false; s.won = false; s.time = 0;
  s.bossIds = []; s.hitstop = 0;
}

// ---------------- wave composition (mixed hordes + bosses) ----------------

const BOSS_WAVES: Record<number, EnemyKind> = { 3: "rotking", 6: "ripper", 9: "broodmother" };

export function buildWave(n: number): { queue: EnemyKind[]; boss: EnemyKind | null; finale: boolean } {
  if (n === 10) return { queue: [], boss: null, finale: true };
  const boss = BOSS_WAVES[n] ?? null;
  if (boss) return { queue: [], boss, finale: false };
  // mixed horde: never single-type. Wave 1 is the onboarding wave: a
  // slightly smaller horde so a new player gets a fairer opening.
  const total = n === 1 ? 7 : Math.min(6 + n * 3, 34);
  const queue: EnemyKind[] = [];
  for (let i = 0; i < total; i++) {
    const r = Math.random();
    if (n >= 4 && r < 0.06 && count(queue, "brute") < 1 + Math.floor(n / 4)) queue.push("brute");
    else if (n >= 4 && r < 0.14) queue.push("shrieker");
    else if (n >= 3 && r < 0.30) queue.push("rattler");
    else if (r < (n >= 2 ? 0.50 : 0.32)) queue.push("runner"); // wave 1 already mixes runners in
    else queue.push("shambler");
  }
  // shuffle so types interleave
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  return { queue, boss: null, finale: false };
}
function count(q: EnemyKind[], k: EnemyKind) { let n = 0; for (const x of q) if (x === k) n++; return n; }

function spawnEnemy(s: GameState, kind: EnemyKind, hpMulOverride?: number) {
  const d = ENEMIES[kind];
  const a = Math.random() * Math.PI * 2;
  const r = 22 + Math.random() * 4;
  const hpMul = hpMulOverride ?? (IS_BOSS(kind) ? 1 + (s.wave > 3 ? (s.wave / 3 - 1) * 0.25 : 0) : 1 + s.wave * 0.03);
  const e: Enemy = {
    id: s.nextId++, kind,
    pos: { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r },
    yaw: 0, hp: d.hp * hpMul, maxHp: d.hp * hpMul,
    state: "spawn", stateT: 0.9,
    speed: d.speed * (0.9 + Math.random() * 0.2),
    walkPhase: Math.random() * 6, attackCd: 0, dashCd: 2,
    flankPhase: Math.random() * 6,
    dead: false, deadT: 0, summoned: false, summonT: 3,
    slamT: -1, swoopT: 2 + Math.random() * 3,
    dashDir: { x: 0, y: 0, z: 0 }, knockMul: 1,
    variant: Math.floor(Math.random() * 2),
  };
  if (d.flying) e.pos.y = 2.4;
  s.enemies.push(e);
  if (!IS_BOSS(kind)) s.events.push({ t: "groan", pos: { x: 0, y: 0, z: 0 } });
  return e;
}

// ---------------- helpers ----------------

function dirFromYaw(yaw: number, pitch: number): Vec3 {
  return {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch),
  };
}

function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number): number {
  const ox = center.x - origin.x, oy = center.y - origin.y, oz = center.z - origin.z;
  const tca = ox * dir.x + oy * dir.y + oz * dir.z;
  if (tca < 0) return -1;
  const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  return tca - thc;
}

function collideObstacles(s: GameState, pos: Vec3, radius: number) {
  for (const o of s.obstacles) {
    const dx = pos.x - o.x, dz = pos.z - o.z;
    const d = Math.hypot(dx, dz), min = o.r + radius;
    if (d < min && d > 0.001) {
      pos.x = o.x + (dx / d) * min;
      pos.z = o.z + (dz / d) * min;
    }
  }
  const H = ARENA_HALF - 1;
  pos.x = Math.max(-H, Math.min(H, pos.x));
  pos.z = Math.max(-H, Math.min(H, pos.z));
}

function aliveCount(s: GameState) { let n = 0; for (const e of s.enemies) if (!e.dead) n++; return n; }
function bossesAlive(s: GameState) { return s.enemies.filter((e) => !e.dead && IS_BOSS(e.kind)); }

// ---------------- the tick ----------------

export function stepSim(s: GameState, inp: InputState, dt: number) {
  if (s.over || s.won) return;
  if (s.hitstop > 0) { s.hitstop -= dt; return; }
  s.time += dt;
  const p = s.player;

  // --- look ---
  p.yaw -= inp.lookDX * 0.0026;
  p.pitch -= inp.lookDY * 0.0026;
  p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch));

  // --- movement ---
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  let wx = inp.moveX * cy - inp.moveY * sy;
  let wz = -inp.moveX * sy - inp.moveY * cy;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const sprinting = inp.sprint && inp.moveY > 0.1 && p.onGround && !p.sliding;

  // slide trigger
  if (inp.slidePressed && sprinting && !p.sliding && p.moveSpeed > 3) {
    p.sliding = true; p.slideT = 0.85;
    p.slideDir = wl > 0.01 ? { x: wx, y: 0, z: wz } : { x: -sy, y: 0, z: -cy };
    p.iframes = Math.max(p.iframes, 0.3);
    s.events.push({ t: "slideStart" });
  }

  const WALK = 4.3, SPRINT = 6.9;
  if (p.sliding) {
    p.slideT -= dt;
    const k = Math.max(0, p.slideT / 0.85);
    const sp = 3 + 7.5 * k;
    p.vel.x = p.slideDir.x * sp + wx * 1.2;
    p.vel.z = p.slideDir.z * sp + wz * 1.2;
    if (p.slideT <= 0) p.sliding = false;
  } else {
    const target = sprinting ? SPRINT : WALK;
    const accel = p.onGround ? 42 : 10;
    p.vel.x += (wx * target - p.vel.x) * Math.min(1, accel * dt / Math.max(1, target));
    p.vel.z += (wz * target - p.vel.z) * Math.min(1, accel * dt / Math.max(1, target));
    if (wl < 0.01 && p.onGround) {
      p.vel.x *= Math.max(0, 1 - 10 * dt);
      p.vel.z *= Math.max(0, 1 - 10 * dt);
    }
  }

  // jump / gravity
  if (inp.jumpPressed && p.onGround && !p.sliding) { p.vel.y = 4.8; p.onGround = false; }
  p.vel.y -= 15 * dt;
  p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt; p.pos.y += p.vel.y * dt;
  if (p.pos.y <= 0) { p.pos.y = 0; p.vel.y = 0; p.onGround = true; }
  collideObstacles(s, p.pos, 0.5);

  p.moveSpeed = Math.hypot(p.vel.x, p.vel.z);
  p.bobPhase += dt * (2 + p.moveSpeed * 1.6);
  p.iframes = Math.max(0, p.iframes - dt);

  // eye height + fov feel
  const targetEye = p.sliding ? 0.95 : 1.62;
  p.eyeH += (targetEye - p.eyeH) * Math.min(1, 12 * dt);
  const targetFov = p.sliding ? 92 : sprinting ? 82 : 75;
  p.fov += (targetFov - p.fov) * Math.min(1, 8 * dt);

  // regen
  if (s.time - p.lastDamageT > 6 && p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + 6 * dt);
  }

  // --- weapons ---
  const w = p.loadout[p.cur];
  if (w) {
    w.cooldown = Math.max(0, w.cooldown - dt);
    p.drawT = Math.max(0, p.drawT - dt);
    if (w.reloading) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        w.reloading = false;
        const d = WEAPONS[w.key];
        const need = d.mag - w.mag;
        const take = w.reserve < 0 ? need : Math.min(need, w.reserve);
        w.mag += take;
        if (w.reserve >= 0) w.reserve -= take;
        s.events.push({ t: "reloadDone" });
      }
    }
    if (inp.swap1 && p.loadout.length > 0 && p.cur !== 0) { swapTo(s, 0); }
    else if (inp.swap2 && p.loadout.length > 1 && p.cur !== 1) { swapTo(s, 1); }

    if (inp.reloadPressed && !w.reloading && w.mag < WEAPONS[w.key].mag && (w.reserve > 0 || w.reserve < 0)) {
      w.reloading = true; w.reloadT = WEAPONS[w.key].reloadTime;
      s.events.push({ t: "reloadStart", weapon: w.key });
    }

    if (inp.fireHeld && !w.reloading && p.drawT <= 0 && p.meleeT <= 0) {
      if (w.cooldown <= 0) {
        if (w.mag > 0) fireWeapon(s, w);
        else { s.events.push({ t: "dryFire" }); w.cooldown = 0.3; }
      }
    }
  }

  // --- melee ---
  p.meleeCd = Math.max(0, p.meleeCd - dt);
  p.meleeT = Math.max(0, p.meleeT - dt);
  if (inp.meleePressed && p.meleeCd <= 0) {
    p.meleeCd = 0.55; p.meleeT = 0.32;
    s.events.push({ t: "melee" });
    const dir = dirFromYaw(p.yaw, 0);
    for (const e of s.enemies) {
      if (e.dead) continue;
      const ed = ENEMIES[e.kind];
      const cy2 = ed.flying ? e.pos.y : e.pos.y + ed.height * 0.55;
      if (Math.abs(cy2 - (p.pos.y + p.eyeH)) > 1.8) continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 2.6 + ed.radius) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * dir.x + dz * dir.z) / Math.max(0.001, dist))));
      if (ang < 1.0) damageEnemy(s, e, 55, false, { x: e.pos.x, y: cy2, z: e.pos.z });
    }
  }

  // --- enemies ---
  updateEnemies(s, dt);

  // --- waves ---
  updateWaves(s, dt);

  // --- death ---
  if (p.hp <= 0 && !s.over) {
    s.over = true;
    s.events.push({ t: "gameOver" });
  }
}

function swapTo(s: GameState, idx: number) {
  const p = s.player;
  const cur = p.loadout[p.cur];
  if (cur && cur.reloading) { cur.reloading = false; }
  p.cur = idx; p.drawT = 0.35;
  s.events.push({ t: "swap", weapon: p.loadout[idx].key });
}

/** Exported for headless hit-registration tests (aim at torso height, assert a hit). */
export function fireWeapon(s: GameState, w: WeaponState) {
  const p = s.player;
  const d = WEAPONS[w.key];
  w.mag--;
  w.cooldown = 60 / d.rpm;
  s.shotsFired += d.pellets;
  const origin: Vec3 = { x: p.pos.x, y: p.pos.y + p.eyeH, z: p.pos.z };
  const base = dirFromYaw(p.yaw, p.pitch);
  s.events.push({ t: "shoot", weapon: w.key, pos: origin, dir: base });

  const spread = w.key === "shotgun" && p.sliding ? d.spread * 0.5 : d.spread;
  interface Hit { e: Enemy; t: number; head: boolean }
  const hits: Hit[] = [];

  for (let pel = 0; pel < d.pellets; pel++) {
    const dir: Vec3 = {
      x: base.x + (Math.random() - 0.5) * 2 * spread,
      y: base.y + (Math.random() - 0.5) * 2 * spread,
      z: base.z + (Math.random() - 0.5) * 2 * spread,
    };
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= dl; dir.y /= dl; dir.z /= dl;

    let best: Hit | null = null;
    for (const e of s.enemies) {
      if (e.dead || e.state === "spawn") continue;
      const ed = ENEMIES[e.kind];
      const bodyC: Vec3 = { x: e.pos.x, y: e.pos.y + ed.height * 0.55, z: e.pos.z };
      const headC: Vec3 = { x: e.pos.x, y: e.pos.y + ed.height * 0.92, z: e.pos.z };
      const th = raySphere(origin, dir, headC, ed.radius * 0.62);
      const tb = raySphere(origin, dir, bodyC, ed.radius);
      let t = -1, head = false;
      if (th > 0 && th < d.range) { t = th; head = true; }
      if (tb > 0 && tb < d.range && (t < 0 || tb < t)) { t = tb; head = false; }
      if (t > 0 && (!best || t < best.t)) best = { e, t, head };
    }
    if (best) {
      if (d.pierce) {
        hits.push(best);
      } else if (!hits.some((h) => h.e === best!.e)) {
        hits.push(best);
      } else {
        let second: Hit | null = null;
        for (const e of s.enemies) {
          if (e.dead || e.state === "spawn" || hits.some((h) => h.e === e)) continue;
          const ed = ENEMIES[e.kind];
          const bodyC: Vec3 = { x: e.pos.x, y: e.pos.y + ed.height * 0.55, z: e.pos.z };
          const t = raySphere(origin, dir, bodyC, ed.radius);
          if (t > 0 && t < d.range && t > best.t && (!second || t < second.t)) second = { e, t, head: false };
        }
        if (second) hits.push(second);
      }
    } else if (Math.abs(dir.y) > 0.001) {
      const t = -origin.y / dir.y;
      if (t > 0 && t < d.range) {
        s.events.push({ t: "hitWorld", pos: { x: origin.x + dir.x * t, y: 0.05, z: origin.z + dir.z * t } });
      }
    }
  }

  s.shotsHit += hits.length;
  hits.sort((a, b) => a.t - b.t);
  hits.forEach((h, i) => {
    const falloff = Math.max(0.4, 1 - (h.t / d.range) * 0.6) * (d.pierce ? Math.pow(0.75, i) : 1);
    damageEnemy(s, h.e, d.damage * (h.head ? 2 : 1) * falloff * h.e.knockMul, h.head,
      { x: h.e.pos.x, y: h.e.pos.y + ENEMIES[h.e.kind].height * (h.head ? 0.92 : 0.55), z: h.e.pos.z });
  });
}

function broodmotherShielded(s: GameState, e: Enemy): boolean {
  if (e.kind !== "broodmother") return false;
  return s.enemies.some((o) => o !== e && !o.dead && IS_MINION(o.kind));
}

function damageEnemy(s: GameState, e: Enemy, dmg: number, headshot: boolean, pos: Vec3) {
  if (e.dead) return;
  // Broodmother shield: immune while any minion lives
  if (broodmotherShielded(s, e)) {
    s.events.push({ t: "shieldHit", pos });
    return;
  }
  e.hp -= dmg;
  const killed = e.hp <= 0;
  s.events.push({ t: "hitEnemy", pos, headshot, killed });
  if (killed) {
    e.dead = true; e.state = "die"; e.stateT = 0; e.deadT = 0;
    const ed = ENEMIES[e.kind];
    if (s.time - s.multiT < 2) s.multiKills++; else s.multiKills = 1;
    s.multiT = s.time;
    const mult = Math.min(s.multiKills, 5);
    const score = ed.score * mult;
    s.score += score; s.kills++;
    s.events.push({ t: "enemyDie", id: e.id, pos: { x: e.pos.x, y: 1, z: e.pos.z }, kind: e.kind, score, headshot });
    if (headshot) s.hitstop = 0.07;
    // drops
    if (IS_BOSS(e.kind)) {
      // boss kill shower: full ammo + health
      const p = s.player;
      for (const ws of p.loadout) {
        const wd = WEAPONS[ws.key];
        if (ws.reserve >= 0) ws.reserve += wd.mag * 2;
      }
      p.hp = Math.min(p.maxHp, p.hp + 40);
      s.score += 1000;
      s.events.push({ t: "pickup", kind: "ammo", amount: 999 });
      s.events.push({ t: "pickup", kind: "health", amount: 40 });
      s.bossIds = s.bossIds.filter((id) => id !== e.id);
    } else if (e.kind === "brute" || Math.random() < 0.15) {
      const p = s.player;
      const needy = p.loadout.find((x) => x.reserve >= 0 && x.reserve < WEAPONS[x.key].reserve * 0.5 && x.mag < WEAPONS[x.key].mag);
      const target = needy ?? p.loadout[p.cur];
      if (target && target.reserve >= 0) {
        const amt = Math.floor(WEAPONS[target.key].mag * 0.75);
        target.reserve += amt;
        s.events.push({ t: "pickup", kind: "ammo", amount: amt });
      } else if (p.hp < p.maxHp * 0.6) {
        p.hp = Math.min(p.maxHp, p.hp + 25);
        s.events.push({ t: "pickup", kind: "health", amount: 25 });
      }
    }
  }
}

function hurtPlayer(s: GameState, dmg: number, kx = 0, kz = 0) {
  const p = s.player;
  if (p.iframes > 0 || s.over || s.won) return;
  p.hp -= dmg;
  p.lastDamageT = s.time;
  p.vel.x += kx; p.vel.z += kz;
  s.events.push({ t: "playerHit", dmg });
}

// ---------------- enemies ----------------

function updateEnemies(s: GameState, dt: number) {
  const p = s.player;
  for (const e of s.enemies) {
    const d = ENEMIES[e.kind];
    e.walkPhase += dt * (1 + e.speed * 1.4);

    if (e.dead) { e.deadT += dt; continue; }

    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 0.001 ? dx / dist : 0;
    const nz = dist > 0.001 ? dz / dist : 0;

    // face player
    const targetYaw = Math.atan2(-nx, -nz);
    let dy = targetYaw - e.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    e.yaw += dy * Math.min(1, 8 * dt);

    e.stateT += dt;
    e.attackCd = Math.max(0, e.attackCd - dt);
    e.dashCd = Math.max(0, e.dashCd - dt);

    if (d.flying) {
      updateShrieker(s, e, dt, dist, nx, nz);
      collideObstacles(s, e.pos, d.radius);
      continue;
    }

    switch (e.state) {
      case "spawn":
        if (e.stateT >= 0.9) { e.state = "seek"; e.stateT = 0; }
        break;
      case "seek":
        if (e.kind === "rotking") { updateRotKing(s, e, dt, dist, nx, nz); break; }
        if (e.kind === "ripper") { updateRipper(s, e, dt, dist, nx, nz); break; }
        if (e.kind === "broodmother") { updateBroodmother(s, e, dt, dist, nx, nz); break; }
        {
          let mx = nx, mz = nz;
          if (e.kind === "runner" || e.kind === "rattler") {
            e.flankPhase += dt * (e.kind === "rattler" ? 4.2 : 2.6);
            const fa = Math.sin(e.flankPhase) * (e.kind === "rattler" ? 0.9 : 0.55);
            mx = nx + -nz * fa; mz = nz + nx * fa;
            const l = Math.hypot(mx, mz); mx /= l; mz /= l;
          }
          const sp = e.speed * (e.kind === "rattler" ? 1 + 0.15 * Math.sin(e.flankPhase * 2) : 1);
          e.pos.x += mx * sp * dt;
          e.pos.z += mz * sp * dt;
          if (dist < d.attackRange && e.attackCd <= 0) { e.state = "windup"; e.stateT = 0; }
        }
        break;
      case "windup":
        if (e.stateT >= d.windup) {
          e.state = "attack"; e.stateT = 0;
          if (dist < d.attackRange * 1.35) hurtPlayer(s, d.damage);
          e.attackCd = 1.3;
        }
        break;
      case "attack":
        if (e.stateT >= 0.4) { e.state = "seek"; e.stateT = 0; }
        break;
      case "dashWindup":
      case "dashing":
      case "dashStun":
        updateRipper(s, e, dt, dist, nx, nz);
        break;
      case "slam":
        updateRotKing(s, e, dt, dist, nx, nz);
        break;
      case "die":
      case "swoopIn":
      case "swoopOut":
        break;
    }

    // separation (bosses are not pushed)
    for (const o of s.enemies) {
      if (o === e || o.dead) continue;
      const sx = e.pos.x - o.pos.x, sz = e.pos.z - o.pos.z;
      const sd = Math.hypot(sx, sz);
      const min = d.radius + ENEMIES[o.kind].radius + 0.1;
      if (sd < min && sd > 0.001 && !IS_BOSS(e.kind)) {
        e.pos.x += (sx / sd) * (min - sd) * 0.5;
        e.pos.z += (sz / sd) * (min - sd) * 0.5;
      }
    }
    collideObstacles(s, e.pos, d.radius);
  }

  // remove long-dead
  s.enemies = s.enemies.filter((e) => !(e.dead && e.deadT > 2.6));
}

// --- THE ROT KING: AoE slam + 50% summon ---
function updateRotKing(s: GameState, e: Enemy, dt: number, dist: number, nx: number, nz: number) {
  const d = ENEMIES[e.kind];
  if (!e.summoned && e.hp < e.maxHp * 0.5) {
    e.summoned = true;
    const kinds: EnemyKind[] = ["shambler", "runner", "rattler", "shrieker"];
    for (const k of kinds) spawnEnemy(s, k);
    s.events.push({ t: "bossSummon", kind: e.kind });
  }
  if (e.state === "slam") {
    e.slamT -= dt;
    if (e.slamT <= 0) {
      e.slamT = -1;
      e.state = "seek"; e.stateT = 0;
      s.events.push({ t: "bossSlam", pos: { x: e.pos.x, y: 0.1, z: e.pos.z }, radius: 4.6 });
      const p = s.player;
      const pd = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
      if (pd < 4.6) hurtPlayer(s, 40);
      e.attackCd = 2.2;
    }
    return;
  }
  if (dist < 5.2 && e.attackCd <= 0 && Math.random() < 0.6) {
    e.state = "slam"; e.stateT = 0; e.slamT = 1.2;
    return;
  }
  if (dist < d.attackRange && e.attackCd <= 0) { e.state = "windup"; e.stateT = 0; return; }
  e.pos.x += nx * e.speed * dt;
  e.pos.z += nz * e.speed * dt;
}

// --- THE RIPPER: telegraphed dash ---
function updateRipper(s: GameState, e: Enemy, dt: number, dist: number, nx: number, nz: number) {
  const d = ENEMIES[e.kind];
  const p = s.player;
  switch (e.state) {
    case "seek": {
      if (dist > 5 && e.dashCd <= 0) {
        e.state = "dashWindup"; e.stateT = 0;
        e.dashDir = { x: nx, y: 0, z: nz };
        s.events.push({ t: "dashTelegraph", id: e.id, pos: { x: e.pos.x, y: 0, z: e.pos.z }, dir: { x: nx, y: 0, z: nz } });
        return;
      }
      if (dist < d.attackRange && e.attackCd <= 0) { e.state = "windup"; e.stateT = 0; return; }
      e.pos.x += nx * e.speed * dt;
      e.pos.z += nz * e.speed * dt;
      break;
    }
    case "dashWindup":
      // track the player slightly during windup for fairness
      e.dashDir = { x: nx, y: 0, z: nz };
      if (e.stateT >= 0.9) {
        e.state = "dashing"; e.stateT = 0;
        e.dashCd = 5;
      }
      break;
    case "dashing": {
      const sp = 17;
      e.pos.x += e.dashDir.x * sp * dt;
      e.pos.z += e.dashDir.z * sp * dt;
      // hit the player
      const pd = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
      if (pd < 2.2 + d.radius) {
        hurtPlayer(s, 30, e.dashDir.x * 9, e.dashDir.z * 9);
        e.state = "seek"; e.stateT = 0;
        return;
      }
      // hit a wall or obstacle -> stun
      const H = ARENA_HALF - 1 - d.radius;
      let wallHit = Math.abs(e.pos.x) >= H - 0.01 || Math.abs(e.pos.z) >= H - 0.01;
      if (!wallHit) {
        for (const o of s.obstacles) {
          const od = Math.hypot(e.pos.x - o.x, e.pos.z - o.z);
          if (od < o.r + d.radius + 0.05) { wallHit = true; break; }
        }
      }
      if (wallHit) {
        e.state = "dashStun"; e.stateT = 0; e.knockMul = 1.5;
        s.events.push({ t: "dashStun", id: e.id });
        return;
      }
      if (e.stateT >= 1.1) { e.state = "seek"; e.stateT = 0; }
      break;
    }
    case "dashStun":
      e.knockMul = 1.5;
      if (e.stateT >= 2.0) { e.state = "seek"; e.stateT = 0; e.knockMul = 1; e.dashCd = 4; }
      break;
  }
}

// --- THE BROODMOTHER: summoner with shield ---
function updateBroodmother(s: GameState, e: Enemy, dt: number, dist: number, nx: number, nz: number) {
  const d = ENEMIES[e.kind];
  e.summonT -= dt;
  const minions = s.enemies.filter((o) => o !== e && !o.dead && IS_MINION(o.kind)).length;
  if (e.summonT <= 0 && minions < 6) {
    e.summonT = 6;
    const kinds: EnemyKind[] = ["shambler", "runner", "rattler", "shrieker"];
    spawnEnemy(s, kinds[Math.floor(Math.random() * kinds.length)]);
    s.events.push({ t: "bossSummon", kind: e.kind });
  }
  if (dist < d.attackRange && e.attackCd <= 0) { e.state = "windup"; e.stateT = 0; return; }
  e.pos.x += nx * e.speed * dt;
  e.pos.z += nz * e.speed * dt;
}

// --- SHRIEKER: flying harasser ---
function updateShrieker(s: GameState, e: Enemy, dt: number, dist: number, nx: number, nz: number) {
  const p = s.player;
  const d = ENEMIES[e.kind];
  e.swoopT -= dt;
  const hoverY = 2.5 + Math.sin(e.walkPhase * 0.7) * 0.3;

  if (e.state === "seek" || e.state === "spawn") {
    // hover toward the player on a sine path, but keep a ~3m standoff —
    // never drift into the player's face
    e.pos.y += (hoverY - e.pos.y) * Math.min(1, 3 * dt);
    if (e.state === "seek") {
      const px = nx + -nz * Math.sin(e.flankPhase) * 0.6;
      const pz = nz + nx * Math.sin(e.flankPhase) * 0.6;
      const radial = Math.max(-1, Math.min(1, (dist - 3.0) * 0.8));
      e.pos.x += (px * 0.5 + nx * radial) * e.speed * dt;
      e.pos.z += (pz * 0.5 + nz * radial) * e.speed * dt;
      if (dist > 4 && e.swoopT <= 0) {
        e.state = "swoopIn"; e.stateT = 0;
      }
    }
    if (e.state === "spawn" && e.stateT >= 0.9) { e.state = "seek"; e.stateT = 0; }
  } else if (e.state === "swoopIn") {
    // dive at the player
    const sp = 11;
    e.pos.x += nx * sp * dt;
    e.pos.z += nz * sp * dt;
    const targetY = p.pos.y + 1.3;
    e.pos.y += (targetY - e.pos.y) * Math.min(1, 6 * dt);
    const d3 = Math.hypot(p.pos.x - e.pos.x, (p.pos.y + 1.4) - e.pos.y, p.pos.z - e.pos.z);
    if (d3 < 1.8) {
      hurtPlayer(s, d.damage);
      e.state = "swoopOut"; e.stateT = 0; e.swoopT = 4 + Math.random() * 2;
    } else if (e.stateT > 1.2) {
      e.state = "swoopOut"; e.stateT = 0; e.swoopT = 4 + Math.random() * 2;
    }
  } else if (e.state === "swoopOut") {
    // climb away, then resume hovering
    e.pos.x -= nx * 4 * dt;
    e.pos.z -= nz * 4 * dt;
    e.pos.y += (hoverY - e.pos.y) * Math.min(1, 3 * dt);
    if (e.stateT > 0.8) { e.state = "seek"; e.stateT = 0; }
  }
}

// ---------------- waves ----------------

function updateWaves(s: GameState, dt: number) {
  const alive = aliveCount(s);
  const isFinale = s.wave === 10;
  if (s.waveState === "breather") {
    s.waveT -= dt;
    if (s.waveT <= 0) {
      s.wave++;
      if (s.wave > MAX_WAVE) { s.wave = MAX_WAVE; return; }
      const { queue, boss, finale } = buildWave(s.wave);
      s.spawnQueue = queue;
      s.spawnT = 0.5;
      s.waveState = "active";
      s.events.push({ t: "waveStart", n: s.wave, boss, finale });
      if (finale) {
        // PROTOCOL OMEGA: all three bosses, 75% HP
        for (const k of ["rotking", "ripper", "broodmother"] as EnemyKind[]) {
          const e = spawnEnemy(s, k, 0.75);
          s.bossIds.push(e.id);
        }
        s.trickleT = 3;
      } else if (boss) {
        const e = spawnEnemy(s, boss);
        s.bossIds.push(e.id);
        s.trickleT = 3;
      }
    }
  } else {
    s.spawnT -= dt;
    if (s.spawnQueue.length > 0 && s.spawnT <= 0 && alive < s.maxConcurrent) {
      const kind = s.spawnQueue.shift()!;
      spawnEnemy(s, kind);
      // wave 1 trickles in slower: a few seconds of extra spawn grace
      s.spawnT = s.wave === 1 ? 1.1 : 0.7;
    }
    // boss/finale trickle — only while the boss(es) stand; once they fall
    // the wave is decided, so stop feeding minions
    const bossWave = s.wave === 3 || s.wave === 6 || s.wave === 9 || isFinale;
    const bossesStillUp = bossesAlive(s).length > 0;
    if (bossWave && bossesStillUp) {
      s.trickleT -= dt;
      const cap = isFinale ? 8 : 5;
      if (s.trickleT <= 0 && alive < cap) {
        const kinds: EnemyKind[] = ["shambler", "runner", "rattler", "shrieker"];
        spawnEnemy(s, kinds[Math.floor(Math.random() * kinds.length)]);
        s.trickleT = isFinale ? 3.5 : 4.5;
        // finale generosity: steady ammo
        if (isFinale) {
          const p = s.player;
          const ws = p.loadout[p.cur];
          if (ws && ws.reserve >= 0) {
            ws.reserve += Math.floor(WEAPONS[ws.key].mag * 0.25);
            s.events.push({ t: "pickup", kind: "ammo", amount: Math.floor(WEAPONS[ws.key].mag * 0.25) });
          }
        }
      }
    }
    if (bossWave) {
      // dev-only guard: a single-boss wave must never field 2+ bosses
      if (import.meta.env.DEV && !isFinale && bossesAlive(s).length > 1) {
        console.warn(`[rot] wave ${s.wave}: ${bossesAlive(s).length} bosses alive on a single-boss wave`);
      }
      // boss waves clear the moment the boss(es) die — leftover trickle
      // minions persist into the breather, which is fine
      if (!bossesStillUp) {
        if (isFinale) {
          s.won = true;
          s.events.push({ t: "victory" });
        } else {
          s.waveState = "breather";
          s.waveT = 6;
          s.events.push({ t: "waveClear" });
        }
      }
    } else if (s.spawnQueue.length === 0 && alive === 0 && !bossesStillUp) {
      s.waveState = "breather";
      s.waveT = 6;
      s.events.push({ t: "waveClear" });
    }
  }
}

// ---------------- debug helpers (test logic paths without a browser) ----------------

export function testBuildWave() {
  const out: string[] = [];
  for (let n = 1; n <= 10; n++) {
    const { queue, boss, finale } = buildWave(n);
    const counts: Record<string, number> = {};
    for (const k of queue) counts[k] = (counts[k] ?? 0) + 1;
    const kinds = Object.keys(counts).length;
    out.push(`wave ${n}: boss=${boss} finale=${finale} total=${queue.length} distinct=${kinds} ${JSON.stringify(counts)}`);
  }
  return out;
}

/** Debug only: stage a few enemies in front of the player for visual checks.
 *  Used by ?artcheck=<map> screenshot runs. Not part of gameplay. */
export function debugStage(s: GameState) {
  s.wave = 1;
  s.waveState = "active";
  s.spawnQueue = [];
  const p = s.player;
  const dx = -Math.sin(p.yaw), dz = -Math.cos(p.yaw);
  const kinds: EnemyKind[] = ["shambler", "runner", "brute", "rattler", "shrieker"];
  const lats = [-4.5, -2, 0.5, 3, -3.5];
  kinds.forEach((k, i) => {
    const e = spawnEnemy(s, k);
    const fwd = 7 + i * 1.2, lat = lats[i] * 0.4;
    // ahead of the player with a small lateral spread (right = (-dz, dx))
    e.pos.x = p.pos.x + dx * fwd + -dz * lat;
    e.pos.z = p.pos.z + dz * fwd + dx * lat;
    e.state = "seek";
    e.stateT = 0;
    if (ENEMIES[k].flying) e.pos.y = 2.4;
  });
}

/** Debug only: kill everything damageable. Used by headless logic tests. */
export function debugKillAll(s: GameState) {
  for (const e of [...s.enemies]) {
    if (!e.dead && e.state !== "spawn") {
      damageEnemy(s, e, 999999, false, { x: e.pos.x, y: 1, z: e.pos.z });
    }
  }
}
