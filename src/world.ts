/**
 * ROT PROTOCOL — Three.js rendering layer. Reads GameState, never mutates it.
 * Pixel look: fixed low internal resolution (426x240), CSS upscaled.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import type { GameState, Enemy, EnemyKind, MapKey, WeaponKey, Obstacle } from "./sim";
import { ENEMIES } from "./sim";

const PX_H_BASE = 240;

function computeInternalSize(): [number, number] {
  const w = window.innerWidth, h = window.innerHeight;
  const aspect = w / Math.max(1, h);
  let iw: number, ih: number;
  if (aspect >= 1) { ih = PX_H_BASE; iw = Math.round(PX_H_BASE * aspect); }
  else { iw = PX_H_BASE; ih = Math.round(PX_H_BASE / aspect); }
  iw = Math.max(160, Math.min(720, iw));
  ih = Math.max(160, Math.min(720, ih));
  return [iw, ih];
}

// ---------------- procedural pixel textures ----------------

function pixelTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 64, h = 64): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function groundTexture(map: MapKey): THREE.CanvasTexture {
  return pixelTexture((g, w, h) => {
    // brighter than before: the scene must read, not drown
    g.fillStyle = map === "graveyard" ? "#232e28" : "#1a1f26";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = (Math.random() * w) | 0, y = (Math.random() * h) | 0;
      const v = Math.random();
      g.fillStyle = map === "graveyard"
        ? (v < 0.5 ? "#1f2a24" : v < 0.8 ? "#2a362d" : "#31402f")
        : (v < 0.5 ? "#161b22" : v < 0.8 ? "#1e242e" : "#252c38");
      g.fillRect(x, y, 2, 2);
    }
    if (map === "city") {
      // asphalt cracks
      g.fillStyle = "#12161c";
      for (let i = 0; i < 8; i++) g.fillRect((Math.random() * w) | 0, 0, 1, h);
    }
  });
}

// ---------------- particles (pooled) ----------------

interface Particle { alive: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; maxLife: number; }

class ParticlePool {
  points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private col: Float32Array;
  private parts: Particle[];

  constructor(max: number) {
    this.parts = Array.from({ length: max }, () => ({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 }));
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.09, vertexColors: true, sizeAttenuation: true, depthWrite: false, transparent: true, opacity: 0.95 });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.geo.setDrawRange(0, max);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color) {
    const p = this.parts.find((q) => !q.alive) ?? this.parts[0];
    p.alive = true; p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.maxLife = life;
    const i = this.parts.indexOf(p);
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
  }

  burst(x: number, y: number, z: number, n: number, speed: number, life: number, color: THREE.Color, up = 2) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * speed;
      this.spawn(x, y, z, Math.cos(a) * r, Math.random() * up + 0.5, Math.sin(a) * r, life * (0.6 + Math.random() * 0.7), color);
    }
  }

  update(dt: number) {
    let i = 0;
    for (const p of this.parts) {
      if (p.alive) {
        p.life -= dt;
        if (p.life <= 0) { p.alive = false; this.pos[i * 3 + 1] = -999; }
        else {
          p.vy -= 9 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.y < 0.02) { p.y = 0.02; p.vy = 0; }
          this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
        }
      } else {
        this.pos[i * 3 + 1] = -999;
      }
      i++;
    }
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ---------------- world ----------------

interface EnemyView {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  action: THREE.AnimationAction | null;
  clipKey: string;
  dead: boolean;
  mats: THREE.Material[];
  baseOpacity: number[];
}

interface Telegraph {
  mesh: THREE.Mesh;
  kind: "slam" | "dash";
  t: number; max: number;
  radius: number;
}

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private loader = new GLTFLoader();
  private enemyViews = new Map<number, EnemyView>();
  private modelCache = new Map<EnemyKind, THREE.Object3D>();
  private altModels = new Map<string, THREE.Object3D>();
  private modelClipsMap = new Map<string, THREE.AnimationClip[]>();
  private arenaGroup = new THREE.Group();
  private particles: ParticlePool;
  private flickerLights: THREE.PointLight[] = [];
  private muzzleLight: THREE.PointLight;
  private muzzleFlash: THREE.Mesh;
  private gunRig = new THREE.Group();
  private gunMixers: THREE.AnimationMixer[] = [];
  private gunClips = new Map<string, THREE.AnimationClip[]>();
  private curGun: WeaponKey | null = null;
  private kick = 0;
  private shake = 0;
  private telegraphs: Telegraph[] = [];
  private bossLight: THREE.PointLight | null = null;
  private ambient: THREE.AmbientLight;
  private shieldMesh: THREE.Mesh | null = null;
  fps = 60;
  quality = 0; // 0 full, 1 reduced, 2 minimal
  private lowT = 0;
  private hiT = 0;
  isTouch: boolean;
  private lastLookYaw = 0;
  private lastLookPitch = 0;

  constructor(canvas: HTMLCanvasElement, isTouch: boolean) {
    this.isTouch = isTouch;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = false;
    // three r155+: lights use physical units by default; keep legacy intensity feel
    const [iw, ih] = computeInternalSize();
    this.camera = new THREE.PerspectiveCamera(75, iw / ih, 0.05, 260);
    this.fitViewport();
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x0a1220);
    this.scene.fog = new THREE.Fog(0x101820, 8, isTouch ? 34 : 52);

    // ---- lighting pass: the scene must READ. cold moonlight key, warm fill,
    // dim blue ambient so nothing is ever pitch black.
    const hemi = new THREE.HemisphereLight(0x5a6f8e, 0x1a2030, 1.25);
    this.scene.add(hemi);
    const moon = new THREE.DirectionalLight(0x9db8dd, 1.15);
    moon.position.set(-14, 22, 8);
    this.scene.add(moon);
    const fill = new THREE.DirectionalLight(0xffd9a0, 0.6);
    fill.position.set(12, 9, -14);
    this.scene.add(fill);
    this.ambient = new THREE.AmbientLight(0x2a3a55, 0.65);
    this.scene.add(this.ambient);

    this.particles = new ParticlePool(isTouch ? 160 : 420);
    this.scene.add(this.particles.points);
    this.scene.add(this.arenaGroup);

    // muzzle flash
    this.muzzleLight = new THREE.PointLight(0xffa63d, 0, 26, 1.7);
    this.camera.add(this.muzzleLight);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.30),
      new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.camera.add(this.muzzleFlash);
    this.camera.add(this.gunRig);

    // boss glow light (reused, attached to whichever boss is present)
    this.bossLight = new THREE.PointLight(0xff3b30, 0, 18, 1.6);
    this.scene.add(this.bossLight);

    // shield bubble for the broodmother
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    this.shieldMesh.visible = false;
    this.scene.add(this.shieldMesh);
  }

  /** Match the internal render buffer to the real screen aspect so the
   *  canvas always fills the visible screen exactly: no stretch, no crop,
   *  no letterbox. Called on resize + visualViewport changes. */
  fitViewport() {
    const [iw, ih] = computeInternalSize();
    this.renderer.setSize(iw, ih, false);
    this.camera.aspect = iw / ih;
    this.camera.updateProjectionMatrix();
  }

  // ---------- asset loading ----------

  private kitCache = new Map<string, THREE.Object3D>();

  private async loadKitModel(path: string): Promise<THREE.Object3D | null> {
    if (this.kitCache.has(path)) return this.kitCache.get(path)!;
    try {
      const g = await this.loader.loadAsync(`./models/${path}`);
      this.kitCache.set(path, g.scene);
      return g.scene;
    } catch {
      return null;
    }
  }

  async loadAll(onProgress: (pct: number) => void) {
    const kinds: EnemyKind[] = ["shambler", "runner", "brute", "rattler", "shrieker", "rotking", "ripper", "broodmother"];
    const graveKit = [
      "graveyard/gstone-cross.glb", "graveyard/gstone-round.glb",
      "graveyard/gstone-broken.glb", "graveyard/gstone-wide.glb",
      "graveyard/deadtree.glb", "graveyard/deadtree-long.glb",
      "graveyard/crypt.glb", "graveyard/fence-wood.glb",
      "graveyard/fence-iron.glb", "graveyard/gate.glb",
      "graveyard/lantern.glb", "graveyard/coffin.glb",
      "graveyard/graveplot.glb", "graveyard/crosswood.glb",
    ];
    const cityKit = [
      "city/building.glb", "city/large1.glb", "city/large2.glb",
      "city/car.glb", "city/suv.glb", "city/policecar.glb",
      "city/roadstrip.glb", "city/roadbits.glb", "city/trafficlight.glb",
    ];
    const total = kinds.length + 5 + graveKit.length + cityKit.length; // +5 gun rigs
    let done = 0;
    const tick = () => { done++; onProgress(done / total); };
    for (const k of kinds) {
      try {
        const g = await this.loader.loadAsync(`./models/${ENEMIES[k].gltf}`);
        this.modelCache.set(k, g.scene);
        this.modelClipsMap.set(k, g.animations ?? []);
      } catch { /* fallback to procedural below */ }
      tick();
    }
    // spare zombie variant for horde variety
    try {
      const g = await this.loader.loadAsync("./models/enemies/Zombie_Arm.gltf");
      this.altModels.set("shamblerAlt", g.scene);
      this.modelClipsMap.set("shamblerAlt", g.animations ?? []);
    } catch { /* shamblers just use the base model */ }
    const guns: Array<[string, string]> = [
      ["rifle", "./models/guns/rifle.glb"],
      ["pistol", "./models/guns/pistol.glb"],
      ["shotgun", "./models/guns/shotgun.glb"],
      ["arms", "./models/guns/arms.glb"],
      ["knife", "./models/guns/knife.glb"],
    ];
    const gunScenes = new Map<string, THREE.Object3D>();
    for (const [key, url] of guns) {
      try {
        const g = await this.loader.loadAsync(url);
        gunScenes.set(key, g.scene);
        const clips: THREE.AnimationClip[] = (g as unknown as { animations: THREE.AnimationClip[] }).animations ?? [];
        this.gunClips.set(key, clips);
      } catch { /* procedural fallback */ }
      tick();
    }
    this.buildViewModels(gunScenes);
    // environment kits (cached; setMap clones per placement)
    for (const p of [...graveKit, ...cityKit]) {
      await this.loadKitModel(p);
      tick();
    }
  }

  // ---------- arenas ----------

  // ---------- arenas (real kits: Kenney graveyard, poly.pizza city) ----------

  private kit(path: string): THREE.Object3D | null {
    const t = this.kitCache.get(path);
    return t ? t.clone() : null;
  }

  private placeKit(path: string, x: number, z: number, opts: { y?: number; yaw?: number; scale?: number; tilt?: number } = {}) {
    const m = this.kit(path);
    if (!m) return null;
    m.position.set(x, opts.y ?? 0, z);
    m.rotation.y = opts.yaw ?? 0;
    if (opts.tilt) m.rotation.z = opts.tilt;
    if (opts.scale) m.scale.setScalar(opts.scale);
    this.arenaGroup.add(m);
    return m;
  }

  private segWidth(path: string): number {
    const t = this.kitCache.get(path);
    if (!t) return 2;
    const b = new THREE.Box3().setFromObject(t);
    const s = b.getSize(new THREE.Vector3());
    return Math.max(0.5, s.x, s.z);
  }

  setMap(map: MapKey, obstacles: Obstacle[]) {
    this.arenaGroup.clear();
    this.flickerLights = [];
    // deterministic scatter
    let seed = map === "graveyard" ? 777 : 4242;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

    const isGrave = map === "graveyard";
    this.scene.background = new THREE.Color(isGrave ? 0x0a1424 : 0x0b0d12);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.set(isGrave ? 0x14202e : 0x0d1118);
      this.scene.fog.near = 8;
      this.scene.fog.far = this.isTouch ? 34 : 52;
    }

    const groundTex = groundTexture(map);
    groundTex.repeat.set(12, 12);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshLambertMaterial({ map: groundTex, color: 0xffffff })
    );
    ground.rotation.x = -Math.PI / 2;
    this.arenaGroup.add(ground);

    if (isGrave) {
      // --- GRAVEYARD (Kenney kit): tombstones + dead trees ON the colliders ---
      const stones = ["graveyard/gstone-cross.glb", "graveyard/gstone-round.glb", "graveyard/gstone-broken.glb", "graveyard/gstone-wide.glb"];
      const trees = ["graveyard/deadtree.glb", "graveyard/deadtree-long.glb"];
      for (let i = 0; i < Math.min(14, obstacles.length); i++) {
        const o = obstacles[i];
        this.placeKit(stones[i % stones.length], o.x, o.z, {
          yaw: rnd() * Math.PI * 2,
          scale: 0.9 + rnd() * 0.3,
          tilt: (rnd() - 0.5) * 0.14,
        });
      }
      for (let i = 14; i < Math.min(20, obstacles.length); i++) {
        const o = obstacles[i];
        this.placeKit(trees[(i - 14) % trees.length], o.x, o.z, {
          yaw: rnd() * Math.PI * 2,
          scale: 1.0 + rnd() * 0.5,
        });
      }
      // decorative: crypt landmark at the north edge, coffins, grave plots, crosses
      this.placeKit("graveyard/crypt.glb", 0, -24.5, { yaw: Math.PI, scale: 1.2 });
      this.placeKit("graveyard/coffin.glb", 9, 14, { yaw: 0.7, tilt: 0.1 });
      this.placeKit("graveyard/coffin.glb", -11, -3, { yaw: 2.4 });
      for (let i = 0; i < 10; i++) {
        const a = rnd() * Math.PI * 2, r = 6 + rnd() * 19;
        this.placeKit("graveyard/graveplot.glb", Math.cos(a) * r, Math.sin(a) * r, { yaw: rnd() * Math.PI * 2 });
      }
      for (let i = 0; i < 5; i++) {
        const a = rnd() * Math.PI * 2, r = 8 + rnd() * 16;
        this.placeKit("graveyard/crosswood.glb", Math.cos(a) * r, Math.sin(a) * r, { yaw: rnd() * Math.PI, tilt: (rnd() - 0.5) * 0.2 });
      }
      // iron fence ring at the arena boundary (segment count from real width)
      const segW = this.segWidth("graveyard/fence-iron.glb");
      const ringR = 27.6;
      const n = Math.max(24, Math.ceil((Math.PI * 2 * ringR) / segW));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        this.placeKit("graveyard/fence-iron.glb", Math.cos(a) * ringR, Math.sin(a) * ringR, { yaw: -a + Math.PI / 2 });
      }
      // gate on the south side
      this.placeKit("graveyard/gate.glb", 0, 27.6, { yaw: Math.PI });
      // warm lantern lights (the readable warm accents in the cold moonlight)
      for (const [lx, lz] of [[6, -7], [-8, 6], [2, 13]] as const) {
        this.placeKit("graveyard/lantern.glb", lx, lz, { scale: 1.4 });
        const l = new THREE.PointLight(0xff9a4d, 40, 20, 1.8);
        l.position.set(lx, 2.0, lz);
        l.userData.base = 40;
        this.arenaGroup.add(l);
        this.flickerLights.push(l);
      }
    } else {
      // --- CITY (poly.pizza City Pack): buildings on the 6 blocks, cars on the 5 randoms ---
      const blocks: Array<[number, number]> = [[-16, -16], [16, -16], [-16, 16], [16, 16], [0, -20], [0, 20]];
      // scales chosen so each building's footprint half-diagonal ≈ collider r (5.2):
      // building 4.6x3.9 (diag 6.0), large1 2.3x1.8 (diag 2.9), large2 2.0x1.2 (diag 2.3)
      const bModels: Array<[string, number]> = [
        ["city/building.glb", 1.8], ["city/large1.glb", 3.7], ["city/large2.glb", 4.6],
      ];
      blocks.forEach(([bx, bz], i) => {
        const [mpath, mscale] = bModels[i % bModels.length];
        const b = this.placeKit(mpath, bx, bz, { yaw: (i % 4) * Math.PI / 2, scale: mscale * (0.92 + (i % 3) * 0.08) });
        // subtle per-building tint variation so reused models don't look cloned
        if (b) {
          const tint = 0.85 + ((i * 37) % 20) / 100;
          b.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
              const m2 = mesh.material as THREE.MeshStandardMaterial;
              if (m2 && "color" in m2) { mesh.material = m2.clone(); (mesh.material as THREE.MeshStandardMaterial).color.multiplyScalar(tint); }
            }
          });
        }
      });
      // roads (procedural planes with lane markings — cheap and crisp)
      const roadTex = pixelTexture((g, w, h) => {
        g.fillStyle = "#161a20"; g.fillRect(0, 0, w, h);
        g.fillStyle = "#c8b04a";
        for (let y = 0; y < h; y += 16) g.fillRect(w / 2 - 1, y, 2, 8);
        for (let i = 0; i < 40; i++) {
          g.fillStyle = "#101318";
          g.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 2, 2);
        }
      });
      roadTex.repeat.set(8, 1);
      const roadMat = new THREE.MeshLambertMaterial({ map: roadTex });
      for (const z of [-8, 8]) {
        const road = new THREE.Mesh(new THREE.PlaneGeometry(64, 5), roadMat);
        road.rotation.x = -Math.PI / 2; road.position.set(0, 0.02, z);
        this.arenaGroup.add(road);
      }
      for (const x of [-8, 8]) {
        const road = new THREE.Mesh(new THREE.PlaneGeometry(5, 64), roadMat.clone());
        (road.material as THREE.MeshLambertMaterial).map = roadTex.clone();
        ((road.material as THREE.MeshLambertMaterial).map as THREE.Texture).repeat.set(1, 8);
        ((road.material as THREE.MeshLambertMaterial).map as THREE.Texture).needsUpdate = true;
        road.rotation.x = -Math.PI / 2; road.position.set(x, 0.02, 0);
        this.arenaGroup.add(road);
      }
      // wrecked cars on the random obstacles (colliders r=1.3)
      const cars = ["city/car.glb", "city/suv.glb", "city/policecar.glb"];
      for (let i = 6; i < Math.min(11, obstacles.length); i++) {
        const o = obstacles[i];
        this.placeKit(cars[(i - 6) % cars.length], o.x, o.z, {
          yaw: rnd() * Math.PI * 2,
          tilt: i % 2 ? 0.1 : 0,
          scale: 1.0,
        });
      }
      // traffic lights doubling as sodium street lamps + warm point lights
      const lampPos: Array<[number, number]> = [[-8, -8], [8, 8], [-8, 8], [8, -8]];
      for (const [lx, lz] of lampPos) {
        this.placeKit("city/trafficlight.glb", lx, lz, { yaw: Math.atan2(-lx, -lz), scale: 1.6 });
        const l = new THREE.PointLight(0xffc37a, 34, 22, 1.8);
        l.position.set(lx, 5.2, lz);
        l.userData.base = 34;
        this.arenaGroup.add(l);
        this.flickerLights.push(l);
      }
    }
  }

  // ---------- view models ----------

  // ---------- view models ----------
  // The J-Toastie rigs are modeled at a giant scale with the gun lying along
  // +X. Normalize: uniform scale so the gun reads at real size, rotate the
  // long axis onto -Z (forward), then seat the grip at the anchor point.

  private gunGroups = new Map<WeaponKey | "melee", THREE.Group>();

  private normalizeRig(scene: THREE.Object3D, targetLen: number, rotY: number, anchor: THREE.Vector3): THREE.Group {
    const g = new THREE.Group();
    const inner = new THREE.Group();
    // NOTE: each gun rig template is normalized exactly ONCE (one viewmodel
    // per weapon), so the template is used directly — no clone. Cloning
    // skinned rigs breaks their skeleton binding (plain clone) or their bind
    // matrices (SkeletonUtils.clone), collapsing or displacing the gun.
    inner.add(scene);
    // strip the FPS arm meshes (node "ArmModel"): in a real FPS pose they sit
    // between the camera and the gun and read as a giant tan blob. The gun
    // meshes stay skinned to the armature so idle/shoot/reload still animate.
    const stripped: THREE.Object3D[] = [];
    inner.traverse((o) => { if (o.name === "ArmModel") stripped.push(o); });
    for (const o of stripped) o.parent?.remove(o);
    // measure AFTER a first pass at unit scale
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const s = longest > 0.001 ? targetLen / longest : 1;
    inner.scale.setScalar(s);
    inner.rotation.y = rotY;
    // re-measure with rotation applied, then seat bbox center on the anchor
    const box2 = new THREE.Box3().setFromObject(inner);
    const c = box2.getCenter(new THREE.Vector3());
    inner.position.sub(c).add(anchor);
    g.add(inner);
    return g;
  }

  private buildViewModels(scenes: Map<string, THREE.Object3D>) {
    // anchors are gunRig-local; gunRig itself sits at (0.28,-0.26,-0.55),
    // so this lands the gun center at camera-space ~(0.30,-0.30,-0.72)
    const anchor = new THREE.Vector3(0.02, -0.04, -0.17);
    const show = (key: WeaponKey | "melee", g: THREE.Group | null, animKey: string) => {
      const grp = g ?? new THREE.Group();
      if (!g) grp.add(this.proceduralGun(key));
      // hook up idle animation if the rig has one
      const clips = this.gunClips.get(animKey) ?? [];
      if (clips.length && g) {
        const idle = clips.find((c) => /idle/i.test(c.name));
        if (idle) {
          const mixer = new THREE.AnimationMixer(grp);
          mixer.clipAction(idle).play();
          this.gunMixers.push(mixer);
          this.gunClips.set(key, clips);
        }
      }
      grp.visible = false;
      this.gunRig.add(grp);
      this.gunGroups.set(key, grp);
    };

    const ROT_FWD = Math.PI / 2; // +X -> -Z (muzzle guess; verified visually)

    // rifle: full animated AKM rig (arms come along at correct relative scale)
    const rifleS = scenes.get("rifle");
    show("rifle", rifleS ? this.normalizeRig(rifleS, 0.82, ROT_FWD, anchor) : null, "rifle");

    // pistol: full animated Glock rig
    const pistolS = scenes.get("pistol");
    show("pistol", pistolS ? this.normalizeRig(pistolS, 0.34, ROT_FWD, anchor.clone().add(new THREE.Vector3(-0.02, 0.02, 0.1))) : null, "pistol");

    // shotgun: Mossberg mesh only — the separate arms rig is T-posed wide and
    // does not read as holding the gun, so the gun stands alone (DOOM-style).
    const shotgunS = scenes.get("shotgun");
    if (shotgunS) {
      show("shotgun", this.normalizeRig(shotgunS, 0.85, ROT_FWD, anchor), "shotgun");
    } else {
      show("shotgun", null, "");
    }

    // smg: procedural blocky smg seated at the anchor, no arms
    {
      const g = new THREE.Group();
      const smg = this.proceduralGun("smg");
      const box = new THREE.Box3().setFromObject(smg);
      const c = box.getCenter(new THREE.Vector3());
      smg.position.sub(c).add(anchor);
      g.add(smg);
      show("smg", g, "smg");
    }

    // melee: knife mesh only, angled like a held blade
    const knifeS = scenes.get("knife");
    if (knifeS) {
      const g = new THREE.Group();
      // knife is modeled blade-up (+Y); lay it forward-down
      const inner = new THREE.Group();
      inner.add(knifeS);
      const box = new THREE.Box3().setFromObject(inner);
      const size = box.getSize(new THREE.Vector3());
      const s = 0.42 / Math.max(size.x, size.y, size.z);
      inner.scale.setScalar(s);
      inner.rotation.x = -Math.PI / 2 + 0.35;
      const box2 = new THREE.Box3().setFromObject(inner);
      const c = box2.getCenter(new THREE.Vector3());
      inner.position.sub(c).add(anchor.clone().add(new THREE.Vector3(0.03, -0.02, 0.12)));
      g.add(inner);
      show("melee", g, "knife");
    } else {
      show("melee", null, "");
    }

    // muzzle flash anchor just ahead of the anchor point
    this.muzzleFlash.position.set(0.30, -0.22, -1.35);
    this.muzzleLight.position.set(0.30, -0.22, -1.45);
  }

  private proceduralGun(key: WeaponKey | "melee"): THREE.Group {
    const g = new THREE.Group();
    const dark = new THREE.MeshLambertMaterial({ color: 0x23262b });
    const wood = new THREE.MeshLambertMaterial({ color: 0x4a3421 });
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, m = dark) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      g.add(b);
    };
    if (key === "shotgun") {
      add(0.09, 0.12, 0.9, 0, 0, -0.3); add(0.08, 0.1, 0.5, 0, -0.02, -0.75); add(0.08, 0.16, 0.14, 0, -0.1, 0.08, wood);
    } else if (key === "smg") {
      add(0.08, 0.12, 0.55, 0, 0, -0.25); add(0.06, 0.14, 0.1, 0, -0.12, -0.1); add(0.07, 0.07, 0.2, 0, 0.02, -0.62);
    } else if (key === "melee") {
      add(0.05, 0.06, 0.22, 0, 0, 0, wood);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.42), new THREE.MeshLambertMaterial({ color: 0x9aa2ab }));
      blade.position.set(0, 0.01, -0.3); g.add(blade);
    } else if (key === "pistol") {
      add(0.07, 0.12, 0.28, 0, 0, -0.15); add(0.06, 0.16, 0.08, 0, -0.12, -0.05);
    } else {
      add(0.08, 0.13, 0.85, 0, 0, -0.35); add(0.07, 0.1, 0.3, 0, -0.02, -0.85, wood); add(0.08, 0.18, 0.12, 0, -0.14, 0.05, wood);
    }
    return g;
  }

  setGun(key: WeaponKey | "melee" | null) {
    this.curGun = key === "melee" ? null : key;
    for (const [k, g] of this.gunGroups) g.visible = k === key;
  }

  playGunAnim(kind: "shoot" | "reload") {
    const key = this.curGun ?? "rifle";
    const clips = this.gunClips.get(key) ?? [];
    // gunMixers[0] = rifle rig, gunMixers[1] = pistol rig (insertion order)
    const idx = key === "rifle" ? 0 : key === "pistol" ? 1 : -1;
    const m = idx >= 0 ? this.gunMixers[idx] : null;
    if (m) {
      const re = kind === "shoot" ? /shoot/i : /reload/i;
      const clip = clips.find((c) => re.test(c.name));
      if (clip) {
        const a = m.clipAction(clip);
        a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
      }
    }
    if (kind === "shoot") this.kick = Math.min(this.kick + 0.6, 1.4);
  }

  // ---------- enemies ----------

  private pickClip(clips: THREE.AnimationClip[], names: string[]): THREE.AnimationClip | null {
    for (const n of names) {
      const c = clips.find((cl) => cl.name.toLowerCase().endsWith(n.toLowerCase()));
      if (c) return c;
    }
    return null;
  }

  private enemyClipFor(e: Enemy): string {
    switch (e.state) {
      case "spawn": return "idle";
      case "seek": return e.speed > 3.4 ? "run" : "walk";
      case "windup":
      case "attack": return "attack";
      case "dashWindup": return "attack";
      case "dashing": return "run";
      case "dashStun": return "hit";
      case "slam": return "attack";
      case "swoopIn":
      case "swoopOut": return "fly";
      case "die": return "die";
      default: return "idle";
    }
  }

  private syncEnemy(e: Enemy) {
    let v = this.enemyViews.get(e.id);
    if (!v) {
      const altKey = e.kind === "shambler" && e.variant === 1 ? "shamblerAlt" : null;
      const tpl = altKey ? this.altModels.get(altKey) ?? this.modelCache.get(e.kind) : this.modelCache.get(e.kind);
      const d = ENEMIES[e.kind];
      const group = new THREE.Group();
      let clips: THREE.AnimationClip[] = [];
      let mixer: THREE.AnimationMixer;
      if (tpl) {
        const obj = SkeletonUtils.clone(tpl);
        // Clone materials per enemy: the cached template's materials are
        // shared, and the zombie tint below multiplies color — without this
        // every spawn darkened ALL zombies until they were black blobs.
        obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            const m = mesh.material as THREE.Material | THREE.Material[];
            mesh.material = Array.isArray(m) ? m.map((x) => x.clone()) : m.clone();
          }
        });
        group.add(obj);
        clips = this.modelClips(altKey ?? e.kind);
        mixer = new THREE.AnimationMixer(obj);
      } else {
        // procedural fallback: blocky humanoid
        group.add(this.proceduralEnemy(e.kind));
        mixer = new THREE.AnimationMixer(group);
      }
      group.scale.setScalar(d.scale);
      // tint sickly green for zombies
      if (e.kind === "shambler" || e.kind === "runner" || e.kind === "brute") {
        group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            const m = mesh.material as THREE.MeshStandardMaterial;
            if (m && "color" in m) m.color.multiply(new THREE.Color(0.72, 1.0, 0.72));
          }
        });
      }
      // boss glow marker
      if (e.kind === "rotking") {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.2, 1.6, 24),
          new THREE.MeshBasicMaterial({ color: 0xff4438, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.05;
        group.add(ring);
      }
      this.scene.add(group);
      // collect materials for the near-camera fade (enemies closer than ~1m
      // fade out instead of becoming abstract near-plane blobs)
      const mats: THREE.Material[] = [];
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of list) {
            if (m && !mats.includes(m)) {
              m.transparent = true;
              mats.push(m);
            }
          }
        }
      });
      const baseOpacity = mats.map((m) => m.opacity);
      v = { group, mixer, clips, action: null, clipKey: "", dead: false, mats, baseOpacity };
      this.enemyViews.set(e.id, v);
    }

    const d = ENEMIES[e.kind];
    v.group.position.set(e.pos.x, e.pos.y + (e.state === "spawn" ? -(1 - e.stateT / 0.9) * (d.flying ? 0 : 1.6) : 0), e.pos.z);
    // Quaternius rigs are authored facing +Z; the sim yaw convention faces -Z
    // at yaw 0, so rotate the root by PI to face the movement direction.
    v.group.rotation.y = e.yaw + Math.PI;

    // near-camera fade: enemies inside ~1.9m fade out so a zombie in the
    // player's face never becomes an unreadable screen-filling blob.
    // (flying enemies use their true height, not the ground-enemy chest offset)
    {
      const dx = v.group.position.x - this.camera.position.x;
      const chestY = v.group.position.y + (d.flying ? 0 : 1.0);
      const dy = chestY - this.camera.position.y;
      const dz = v.group.position.z - this.camera.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const f = THREE.MathUtils.clamp((dist - 0.9) / 1.0, 0, 1);
      for (let i = 0; i < v.mats.length; i++) v.mats[i].opacity = v.baseOpacity[i] * f;
      v.group.visible = f > 0.01;
    }

    // shrieker banking
    if (e.kind === "shrieker") v.group.rotation.z = Math.sin(e.walkPhase * 0.7) * 0.15;

    // animation state
    const want = this.enemyClipFor(e);
    if (want !== v.clipKey) {
      v.clipKey = want;
      let clip: THREE.AnimationClip | null = null;
      if (want === "idle") clip = this.pickClip(v.clips, ["Idle", "Flying_Idle"]);
      else if (want === "walk") clip = this.pickClip(v.clips, ["Walk", "Idle"]);
      else if (want === "run") clip = this.pickClip(v.clips, ["Run", "Fast_Flying", "Walk"]);
      else if (want === "attack") clip = this.pickClip(v.clips, ["Attack", "Idle_Attack", "Punch", "Headbutt"]);
      else if (want === "hit") clip = this.pickClip(v.clips, ["HitReact", "HitRecieve", "Duck"]);
      else if (want === "die") clip = this.pickClip(v.clips, ["Death"]);
      else if (want === "fly") clip = this.pickClip(v.clips, ["Fast_Flying", "Flying_Idle"]);
      if (clip) {
        if (v.action) v.action.fadeOut(0.15);
        v.action = v.mixer.clipAction(clip);
        v.action.reset();
        if (want === "die") { v.action.setLoop(THREE.LoopOnce, 1); v.action.clampWhenFinished = true; }
        v.action.fadeIn(0.15).play();
      }
    }

    // death sink
    if (e.dead && e.deadT > 1.6) {
      v.group.position.y -= (e.deadT - 1.6) * 1.2;
    }

    // rotking glow
    if (e.kind === "rotking" && this.bossLight) {
      this.bossLight.position.set(e.pos.x, 3, e.pos.z);
      this.bossLight.intensity = 26 + Math.sin(e.walkPhase * 3) * 8;
    }

    return v;
  }

  private modelClips(key: string): THREE.AnimationClip[] {
    return this.modelClipsMap.get(key) ?? [];
  }

  private proceduralEnemy(kind: EnemyKind): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: kind === "rattler" ? 0xd8d4c8 : 0x5da24a });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.32), mat);
    body.position.y = 1.05;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), mat);
    head.position.y = 1.7;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.2), mat);
    legL.position.set(-0.14, 0.31, 0);
    const legR = legL.clone(); legR.position.x = 0.14;
    g.add(body, head, legL, legR);
    return g;
  }

  clearEnemies() {
    for (const [, v] of this.enemyViews) this.scene.remove(v.group);
    this.enemyViews.clear();
    this.telegraphs = [];
  }

  // ---------- event FX (called from main.ts) ----------

  fxShoot(weapon: WeaponKey) {
    this.playGunAnim("shoot");
    const flash = this.muzzleFlash.material as THREE.MeshBasicMaterial;
    flash.opacity = 1;
    this.muzzleFlash.scale.setScalar(0.7 + Math.random() * 0.6);
    this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    this.muzzleLight.intensity = weapon === "shotgun" ? 130 : weapon === "rifle" ? 95 : 70;
    this.shake = Math.min(this.shake + (weapon === "shotgun" ? 0.35 : weapon === "rifle" ? 0.28 : 0.14), 1);
  }

  fxReload() { this.playGunAnim("reload"); }

  fxBlood(x: number, y: number, z: number, headshot: boolean) {
    const red = new THREE.Color(headshot ? 0xd42a1e : 0x8f1f16);
    this.particles.burst(x, y, z, this.quality === 0 ? 14 : 6, 3.2, 0.7, red);
  }

  fxShieldHit(x: number, y: number, z: number) {
    this.particles.burst(x, y, z, 8, 2, 0.4, new THREE.Color(0x7fd4ff));
  }

  fxWorldHit(x: number, y: number, z: number) {
    this.particles.burst(x, y, z, 5, 1.6, 0.4, new THREE.Color(0x8a7f5c));
  }

  fxDeath(x: number, y: number, z: number, boss: boolean) {
    this.particles.burst(x, y + 0.8, z, this.quality === 0 ? (boss ? 60 : 22) : 10, boss ? 5 : 3.4, 1.1, new THREE.Color(0x7a1812));
    if (boss) this.particles.burst(x, y + 1, z, 30, 4, 1.4, new THREE.Color(0xff6a4d));
  }

  fxSlam(x: number, z: number, _radius = 4.6) {
    this.particles.burst(x, 0.3, z, this.quality === 0 ? 40 : 15, 6, 1.0, new THREE.Color(0x9a8a6a), 4);
    this.shake = Math.min(this.shake + 0.8, 1.4);
  }

  fxSlide() {
    const c = this.camera;
    this.particles.burst(c.position.x, 0.2, c.position.z, 10, 2, 0.5, new THREE.Color(0x5a6a5a));
  }

  fxPickup(kind: "ammo" | "health") {
    const c = this.camera;
    const col = kind === "ammo" ? new THREE.Color(0xe8c34c) : new THREE.Color(0x4ce86a);
    this.particles.burst(c.position.x, 1.4, c.position.z - 1, 16, 1.5, 0.9, col, 1);
  }

  fxMelee() {
    this.setGun("melee");
    this.kick = Math.min(this.kick + 0.5, 1.2);
  }

  fxDashStun() { this.shake = Math.min(this.shake + 0.3, 1); }

  // ---------- per-frame ----------

  update(dt: number, s: GameState, timeSec: number) {
    // fps tracking + auto quality scaler
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    if (this.fps < 30 && this.quality < 2) {
      this.lowT += dt;
      if (this.lowT > 3) { this.quality++; this.lowT = 0; this.applyQuality(); }
    } else this.lowT = 0;
    if (this.fps > 52 && this.quality > 0) {
      this.hiT += dt;
      if (this.hiT > 10) { this.quality--; this.hiT = 0; this.applyQuality(); }
    } else this.hiT = 0;

    // flickering lights (base intensity stored per light at creation)
    const q = this.quality;
    for (let i = 0; i < this.flickerLights.length; i++) {
      const l = this.flickerLights[i];
      const base = (l.userData.base as number) ?? 20;
      l.intensity = q === 2 && i > 0 ? 0 : base * (0.82 + Math.random() * 0.28);
    }

    // enemies
    const seen = new Set<number>();
    let broodmother: Enemy | null = null;
    for (const e of s.enemies) {
      seen.add(e.id);
      this.syncEnemy(e);
      if (e.kind === "broodmother" && !e.dead) broodmother = e;
      // slam telegraph
      if (e.kind === "rotking" && e.state === "slam" && e.slamT > 0) {
        let tg = this.telegraphs.find((t) => t.kind === "slam" && t.mesh.userData.id === e.id);
        if (!tg) {
          const mesh = new THREE.Mesh(
            new THREE.RingGeometry(0.9, 1.0, 40),
            new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
          );
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.set(e.pos.x, 0.07, e.pos.z);
          mesh.userData.id = e.id;
          this.scene.add(mesh);
          tg = { mesh, kind: "slam", t: e.slamT, max: 1.2, radius: 4.6 };
          this.telegraphs.push(tg);
        }
        const k = 1 - e.slamT / tg.max;
        tg.mesh.scale.setScalar(0.2 + k * tg.radius);
        tg.mesh.position.set(e.pos.x, 0.07, e.pos.z);
        (tg.mesh.material as THREE.MeshBasicMaterial).opacity = 0.4 + k * 0.5;
      }
    }
    // ripper dash telegraphs: track live windup state
    for (const e of s.enemies) {
      if (e.state !== "dashWindup" || e.dead) continue;
      let tg = this.telegraphs.find((t) => t.kind === "dash" && t.mesh.userData.id === e.id);
      if (!tg) {
        const len = 30;
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1.1, len),
          new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0.5, depthWrite: false })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.userData.id = e.id;
        this.scene.add(mesh);
        tg = { mesh, kind: "dash", t: 0.9, max: 0.9, radius: 0 };
        this.telegraphs.push(tg);
      }
      const len = 30;
      tg.mesh.position.set(e.pos.x + e.dashDir.x * len / 2, 0.06, e.pos.z + e.dashDir.z * len / 2);
      tg.mesh.rotation.z = Math.atan2(e.dashDir.x, e.dashDir.z);
      (tg.mesh.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.35 * Math.abs(Math.sin(timeSec * 14));
    }
    // remove stale enemy views
    for (const [id, v] of this.enemyViews) {
      if (!seen.has(id)) { this.scene.remove(v.group); this.enemyViews.delete(id); }
    }
    // telegraph cleanup
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const tg = this.telegraphs[i];
      if (tg.kind === "dash") {
        const winding = s.enemies.some((e) => e.id === tg.mesh.userData.id && e.state === "dashWindup" && !e.dead);
        if (!winding) { this.scene.remove(tg.mesh); this.telegraphs.splice(i, 1); }
      } else if (tg.kind === "slam") {
        const stillSlamming = s.enemies.some((e) => e.id === tg.mesh.userData.id && e.state === "slam");
        if (!stillSlamming) { this.scene.remove(tg.mesh); this.telegraphs.splice(i, 1); }
      }
    }

    // broodmother shield bubble
    if (this.shieldMesh) {
      if (broodmother) {
        const shielded = s.enemies.some((o) => o !== broodmother && !o.dead && (o.kind !== "rotking" && o.kind !== "ripper" && o.kind !== "broodmother"));
        this.shieldMesh.visible = shielded;
        if (shielded) {
          this.shieldMesh.position.set(broodmother.pos.x, 2.2, broodmother.pos.z);
          const sc = 2.6 + Math.sin(timeSec * 4) * 0.15;
          this.shieldMesh.scale.setScalar(sc);
          (this.shieldMesh.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(timeSec * 4) * 0.05;
        }
      } else this.shieldMesh.visible = false;
    }

    // enemy animation mixers
    const mixerDt = q === 2 ? dt * 0.75 : dt;
    for (const [, v] of this.enemyViews) v.mixer.update(mixerDt);
    for (const m of this.gunMixers) m.update(dt);

    // camera from sim
    const p = s.player;
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const shx = (Math.random() - 0.5) * 0.09 * this.shake;
    const shy = (Math.random() - 0.5) * 0.09 * this.shake;
    const bobY = Math.sin(p.bobPhase * 2) * 0.028 * Math.min(1, p.moveSpeed / 4);
    const bobX = Math.cos(p.bobPhase) * 0.02 * Math.min(1, p.moveSpeed / 4);
    this.camera.position.set(p.pos.x + bobX + shx, p.pos.y + p.eyeH + bobY + shy, p.pos.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = p.yaw;
    this.camera.rotation.x = p.pitch;
    this.camera.rotation.z = p.sliding ? 0.09 : 0;
    if (Math.abs(this.camera.fov - p.fov) > 0.1) {
      this.camera.fov += (p.fov - this.camera.fov) * Math.min(1, 10 * dt);
      this.camera.updateProjectionMatrix();
    }

    // gun rig: bob + sway + kick
    this.kick = Math.max(0, this.kick - dt * 6);
    const lookSwayX = (p.yaw - this.lastLookYaw) * 2.2;
    const lookSwayY = (p.pitch - this.lastLookPitch) * 2.2;
    this.lastLookYaw = p.yaw; this.lastLookPitch = p.pitch;
    const swayX = THREE.MathUtils.clamp(-lookSwayX * 0.06 + bobX * 0.7, -0.06, 0.06);
    const swayY = THREE.MathUtils.clamp(-lookSwayY * 0.06 + bobY * 0.7, -0.06, 0.06);
    this.gunRig.position.set(0.28 + swayX, -0.26 + swayY - (p.sliding ? 0.05 : 0), -0.55 + this.kick * 0.12);
    this.gunRig.rotation.x = this.kick * 0.16;
    this.gunRig.rotation.z = p.sliding ? 0.25 : 0;

    // muzzle flash decay
    const flash = this.muzzleFlash.material as THREE.MeshBasicMaterial;
    flash.opacity = Math.max(0, flash.opacity - dt * 13);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 420);

    // particles
    this.particles.update(dt);

    // melee auto-hide: main.ts calls setGun back after swing
  }

  private applyQuality() {
    const q = this.quality;
    // tighter fog on minimal
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.far = q === 2 ? 30 : this.isTouch ? 34 : 52;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
