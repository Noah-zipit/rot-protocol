/**
 * ROT PROTOCOL — Three.js rendering layer. Reads GameState, never mutates it.
 * Pixel look: fixed low internal resolution (426x240), CSS upscaled.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import type { GameState, Enemy, EnemyKind, MapKey, WeaponKey } from "./sim";
import { ENEMIES } from "./sim";

const PX_W = 426, PX_H = 240;

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
    g.fillStyle = map === "graveyard" ? "#1a241f" : "#14171c";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = (Math.random() * w) | 0, y = (Math.random() * h) | 0;
      const v = Math.random();
      g.fillStyle = map === "graveyard"
        ? (v < 0.5 ? "#16201b" : v < 0.8 ? "#1f2b24" : "#242f28")
        : (v < 0.5 ? "#101318" : v < 0.8 ? "#171b21" : "#1c2129");
      g.fillRect(x, y, 2, 2);
    }
    if (map === "city") {
      // asphalt cracks
      g.fillStyle = "#0e1114";
      for (let i = 0; i < 8; i++) g.fillRect((Math.random() * w) | 0, 0, 1, h);
    }
  });
}

function buildingTexture(): THREE.CanvasTexture {
  return pixelTexture((g, w, h) => {
    g.fillStyle = "#0d1116"; g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 8) for (let x = 4; x < w; x += 8) {
      g.fillStyle = Math.random() < 0.28 ? "#e8a34c" : "#141a21";
      g.fillRect(x, y, 4, 4);
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
  private map: MapKey = "graveyard";
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
    this.renderer.setSize(PX_W, PX_H, false);
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = false;
    this.camera = new THREE.PerspectiveCamera(75, PX_W / PX_H, 0.05, 220);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x070b12);
    this.scene.fog = new THREE.Fog(0x0a0f16, 8, isTouch ? 34 : 52);

    // lights
    const hemi = new THREE.HemisphereLight(0x3a4a5e, 0x0a0d0a, 0.85);
    this.scene.add(hemi);
    const moon = new THREE.DirectionalLight(0x8fa8c8, 0.5);
    moon.position.set(-14, 22, 8);
    this.scene.add(moon);

    this.particles = new ParticlePool(isTouch ? 160 : 420);
    this.scene.add(this.particles.points);
    this.scene.add(this.arenaGroup);

    // muzzle flash
    this.muzzleLight = new THREE.PointLight(0xffa63d, 0, 14, 1.8);
    this.camera.add(this.muzzleLight);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.22),
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

  // ---------- asset loading ----------

  async loadAll(onProgress: (pct: number) => void) {
    const kinds: EnemyKind[] = ["shambler", "runner", "brute", "rattler", "shrieker", "rotking", "ripper", "broodmother"];
    const total = kinds.length + 5; // +5 gun rigs
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
  }

  // ---------- arenas ----------

  setMap(map: MapKey) {
    this.map = map;
    this.arenaGroup.clear();
    this.flickerLights = [];
    const isGrave = map === "graveyard";

    const groundTex = groundTexture(map);
    groundTex.repeat.set(12, 12);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshLambertMaterial({ map: groundTex, color: 0xffffff })
    );
    ground.rotation.x = -Math.PI / 2;
    this.arenaGroup.add(ground);

    if (isGrave) {
      // moon-green tint ground fog handled by scene fog
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x5c665f });
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x2e2419 });
      // tombstones at obstacle positions (first 14 obstacles)
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const r = 10 + (i % 5) * 3;
        const stone = new THREE.Group();
        const slab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.18), stoneMat);
        slab.position.y = 0.5;
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, 0.18), stoneMat);
        top.position.y = 1.05; top.rotation.z = 0.15;
        stone.add(slab, top);
        stone.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        stone.rotation.y = Math.random() * 0.6 - 0.3;
        stone.rotation.z = (Math.random() - 0.5) * 0.15;
        this.arenaGroup.add(stone);
      }
      // dead trees
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x1f1811 });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.3;
        const r = 20 + (i % 3) * 3;
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 3.4, 5), trunkMat);
        trunk.position.y = 1.7;
        tree.add(trunk);
        for (let b = 0; b < 3; b++) {
          const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 1.6, 4), trunkMat);
          br.position.set((Math.random() - 0.5) * 1.2, 2.4 + b * 0.4, (Math.random() - 0.5) * 1.2);
          br.rotation.z = 0.7 + Math.random() * 0.5;
          tree.add(br);
        }
        tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        this.arenaGroup.add(tree);
      }
      // fence ring
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 0.14), woodMat);
        post.position.set(Math.cos(a) * 27.5, 0.55, Math.sin(a) * 27.5);
        this.arenaGroup.add(post);
      }
      // 2 flickering lantern lights
      for (const [lx, lz] of [[6, -7], [-8, 6]] as const) {
        const l = new THREE.PointLight(0xff9a4d, 14, 16, 1.9);
        l.position.set(lx, 2.2, lz);
        this.arenaGroup.add(l);
        this.flickerLights.push(l);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 5), woodMat);
        pole.position.set(lx, 1.1, lz);
        this.arenaGroup.add(pole);
      }
    } else {
      // CITY
      const bTex = buildingTexture();
      const winMat = new THREE.MeshLambertMaterial({ map: bTex, emissive: 0xff9a4d, emissiveMap: bTex, emissiveIntensity: 0.55 });
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x11151b });
      const blocks: Array<[number, number]> = [[-16, -16], [16, -16], [-16, 16], [16, 16], [0, -20], [0, 20]];
      for (const [bx, bz] of blocks) {
        const h = 9 + (Math.abs(bx * 7 + bz * 3) % 6);
        const b = new THREE.Mesh(new THREE.BoxGeometry(8, h, 8), winMat);
        b.position.set(bx, h / 2, bz);
        this.arenaGroup.add(b);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.3, 8.4), darkMat);
        roof.position.set(bx, h + 0.15, bz);
        this.arenaGroup.add(roof);
      }
      // roads
      const roadMat = new THREE.MeshLambertMaterial({ color: 0x0c0e11 });
      for (const z of [-8, 8]) {
        const road = new THREE.Mesh(new THREE.PlaneGeometry(64, 5), roadMat);
        road.rotation.x = -Math.PI / 2; road.position.set(0, 0.01, z);
        this.arenaGroup.add(road);
      }
      for (const x of [-8, 8]) {
        const road = new THREE.Mesh(new THREE.PlaneGeometry(5, 64), roadMat);
        road.rotation.x = -Math.PI / 2; road.position.set(x, 0.01, 0);
        this.arenaGroup.add(road);
      }
      // wrecked cars (cover, r=1.3 obstacles)
      const carColors = [0x7a2e2e, 0x2e5a7a, 0x6a6a2e, 0x3a3a44, 0x5a2e6a];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.5;
        const r = 11 + (i % 3) * 4;
        const car = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 4.4),
          new THREE.MeshLambertMaterial({ color: carColors[i % carColors.length] }));
        body.position.y = 0.65;
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.0), darkMat);
        cabin.position.set(0, 1.2, -0.2);
        car.add(body, cabin);
        for (const [wx, wz] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]] as const) {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 8),
            new THREE.MeshLambertMaterial({ color: 0x0a0a0a }));
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(wx, 0.38, wz);
          car.add(wheel);
        }
        car.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        car.rotation.y = a + 1.2;
        if (i % 2) car.rotation.z = 0.12; // wrecked tilt
        this.arenaGroup.add(car);
      }
      // flickering streetlights
      for (const [lx, lz] of [[-8, -8], [8, 8], [-8, 8]] as const) {
        const l = new THREE.PointLight(0xffd9a0, 18, 22, 1.8);
        l.position.set(lx, 5.5, lz);
        this.arenaGroup.add(l);
        this.flickerLights.push(l);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5.5, 6), darkMat);
        pole.position.set(lx, 2.75, lz);
        this.arenaGroup.add(pole);
      }
    }
  }

  // ---------- view models ----------

  private gunGroups = new Map<WeaponKey | "melee", THREE.Group>();

  private buildViewModels(scenes: Map<string, THREE.Object3D>) {
    this.gunRig.position.set(0.28, -0.26, -0.55);
    this.gunRig.rotation.y = -0.04;

    const addRigged = (key: WeaponKey | "melee", scene: THREE.Object3D | undefined, animKey: string, pos: [number, number, number], scale: number, rotY = 0) => {
      const g = new THREE.Group();
      if (scene) {
        scene.position.set(...pos);
        scene.scale.setScalar(scale);
        scene.rotation.y = rotY;
        g.add(scene);
        const clips = this.gunClips.get(animKey) ?? [];
        if (clips.length) {
          const mixer = new THREE.AnimationMixer(scene);
          const idle = clips.find((c) => /idle/i.test(c.name));
          if (idle) { mixer.clipAction(idle).play(); }
          this.gunMixers.push(mixer);
          this.gunClips.set(key, clips);
        }
      } else {
        // procedural fallback: blocky gun
        g.add(this.proceduralGun(key));
      }
      g.visible = false;
      this.gunRig.add(g);
      this.gunGroups.set(key, g);
    };

    // rifle: full animated AKM rig
    addRigged("rifle", scenes.get("rifle"), "rifle", [0, 0, 0], 1);
    // pistol: animated Glock rig
    addRigged("pistol", scenes.get("pistol"), "pistol", [0, 0, 0], 1);
    // shotgun + smg: static arms + gun in right hand
    const armsS = scenes.get("arms");
    const shotgunGun = scenes.get("shotgun");
    if (armsS && shotgunGun) {
      const g = new THREE.Group();
      g.add(armsS);
      const hand = this.findBone(armsS, "Hand.R");
      if (hand) {
        shotgunGun.position.set(0, -0.02, 0.05);
        shotgunGun.rotation.set(0, Math.PI / 2, 0);
        shotgunGun.scale.setScalar(1.4);
        hand.add(shotgunGun);
      } else {
        shotgunGun.position.set(0.1, 0, -0.3);
        g.add(shotgunGun);
      }
      g.visible = false;
      this.gunRig.add(g);
      this.gunGroups.set("shotgun", g);
    } else {
      addRigged("shotgun", undefined, "", [0, 0, 0], 1);
    }
    // smg: arms + procedural blocky smg
    if (armsS) {
      const g = new THREE.Group();
      const armsClone = armsS.clone(true);
      g.add(armsClone);
      const hand = this.findBone(armsClone, "Hand.R");
      const smg = this.proceduralGun("smg");
      smg.scale.setScalar(0.8);
      if (hand) { smg.position.set(0, 0, 0.1); hand.add(smg); }
      else { smg.position.set(0.1, 0, -0.3); g.add(smg); }
      g.visible = false;
      this.gunRig.add(g);
      this.gunGroups.set("smg", g);
    } else {
      addRigged("smg", undefined, "", [0, 0, 0], 1);
    }
    // melee: knife in right hand
    const knifeS = scenes.get("knife");
    if (armsS && knifeS) {
      const g = new THREE.Group();
      const armsClone = armsS.clone(true);
      g.add(armsClone);
      const hand = this.findBone(armsClone, "Hand.R");
      if (hand) { knifeS.position.set(0, 0, 0.08); knifeS.scale.setScalar(1.6); hand.add(knifeS); }
      else { knifeS.position.set(0.15, 0, -0.3); g.add(knifeS); }
      g.visible = false;
      this.gunRig.add(g);
      this.gunGroups.set("melee", g);
    } else {
      addRigged("melee", undefined, "", [0, 0, 0], 1);
    }

    // muzzle flash anchor
    this.muzzleFlash.position.set(0.28, -0.1, -1.1);
    this.muzzleLight.position.set(0.28, -0.1, -1.2);
  }

  private findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    root.traverse((o) => { if (o.name === name && !found) found = o; });
    return found;
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
      v = { group, mixer, clips, action: null, clipKey: "", dead: false };
      this.enemyViews.set(e.id, v);
    }

    const d = ENEMIES[e.kind];
    v.group.position.set(e.pos.x, e.pos.y + (e.state === "spawn" ? -(1 - e.stateT / 0.9) * (d.flying ? 0 : 1.6) : 0), e.pos.z);
    v.group.rotation.y = e.yaw;

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
    this.muzzleLight.intensity = weapon === "shotgun" ? 60 : 34;
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

    // flickering lights
    const q = this.quality;
    for (let i = 0; i < this.flickerLights.length; i++) {
      const l = this.flickerLights[i];
      const base = this.map === "graveyard" ? 14 : 18;
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
    flash.opacity = Math.max(0, flash.opacity - dt * 22);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 900);

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
