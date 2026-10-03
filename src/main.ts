/**
 * ROT PROTOCOL — boot, screen state machine, fixed-timestep loop.
 * Wires sim events -> audio, world FX, UI.
 */
import "@fontsource/press-start-2p/index.css";
import "./style.css";
import { createGame, startRun, stepSim, debugStage, FIXED_DT, ENEMIES, IS_BOSS, expeditionHooks, type GameState, type GameEvent, type WeaponKey } from "./sim";
import { InputManager, isTouchDevice } from "./input";
import { GameAudio } from "./audio";
import { World } from "./world";
import { UI } from "./ui";
import { loadStash, saveStash, buyUpgrade, startExpeditionRun, stepExpedition, type Stash } from "./expedition";

// expedition sim step hook: sim.ts never imports expedition.ts, so no cycle
expeditionHooks.step = stepExpedition;

const BOSS_NAMES: Record<string, string> = {
  rotking: "THE ROT KING",
  ripper: "THE RIPPER",
  broodmother: "THE BROODMOTHER",
};

class Game {
  private canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  private input = new InputManager(this.canvas);
  private audio = new GameAudio();
  private ui = new UI();
  private world: World | null = null;
  private sim: GameState | null = null;
  private acc = 0;
  private lastT = 0;
  private meleeReturnT = 0;
  private paused = false;
  private muted = false;
  // expedition: persistent stash (banked loot + upgrades, survives death)
  private stash: Stash = loadStash();
  // desktop pointer-lock tracking: losing lock mid-run (or never acquiring
  // it) leaves the player defenseless — auto-pause instead
  private lockWasHeld = false;
  private runStartT = 0;
  // test-only: ?noautopause=1 skips the pointer-lock auto-pause so headless
  // captures can see live frames (same pattern as ?artcheck=)
  private noAutoPause = false;

  async boot() {
    this.ui.show("loading");
    this.ui.setLoading(0, "BUILDING ARENA");
    this.world = new World(this.canvas, isTouchDevice);
    try {
      await this.world.loadAll((p) => this.ui.setLoading(p, "LOADING MODELS"));
    } catch {
      // models failed; world has procedural fallbacks
    }
    this.wireUI();
    this.ui.onQuality = (m) => this.world?.setQualityMode(m as "auto" | "high" | "medium" | "low");
    this.ui.setQualityMode(this.world.qualityMode);
    // keep the render buffer matched to the real visible screen
    const onResize = () => {
      this.world?.fitViewport();
      this.ui.checkOrientation();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    this.ui.checkOrientation();
    this.ui.show("title");
    // ?artcheck=<graveyard|city>: test-only auto-run with staged enemies for screenshots
    const art = new URLSearchParams(location.search).get("artcheck");
    this.noAutoPause = new URLSearchParams(location.search).has("noautopause");
    if (art === "graveyard" || art === "city") {
      this.ui.selectedMap = art;
      this.startRun(["pistol", "shotgun"]);
      if (this.sim) debugStage(this.sim);
    }
    this.lastT = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private wireUI() {
    const ui = this.ui;
    ui.onMode = () => {
      this.audio.unlock();
      this.audio.uiClick();
      ui.resetLoadout();
      ui.show("loadout");
    };
    ui.onStash = () => {
      this.audio.unlock();
      this.audio.uiClick();
      this.ui.renderStash(this.stash);
      this.ui.show("stash");
    };
    ui.onStashBack = () => {
      this.audio.uiClick();
      this.ui.show("title");
    };
    ui.onBuyUpgrade = (key) => {
      if (buyUpgrade(this.stash, key)) {
        saveStash(this.stash);
        this.ui.renderStash(this.stash);
        this.audio.pickup();
      } else {
        this.audio.dryFire();
      }
    };
    ui.onDeploy = () => {
      this.audio.unlock();
      this.audio.uiClick();
      this.startRun();
    };
    ui.onResume = () => { this.audio.uiClick(); this.togglePause(false); };
    ui.onQuit = () => { this.audio.uiClick(); this.toTitle(); };
    ui.onRestart = () => { this.audio.uiClick(); this.toTitle(); };
    ui.onLockClick = () => { this.input.lockPointer(); };

    this.input.onMute = () => {
      this.muted = this.audio.toggleMute();
      this.ui.popup(this.muted ? "MUTED" : "SOUND ON", "info");
    };
    this.input.onPauseKey = () => this.togglePause();

    // clicking the canvas re-locks the pointer if it was lost
    this.canvas.addEventListener("click", () => {
      if (this.ui.screen === "playing" && !this.paused && !isTouchDevice && !this.input.locked) {
        this.input.lockPointer();
      }
    });
  }

  private startRun(loadout?: WeaponKey[]) {
    const isExp = this.ui.gameMode === "expedition";
    const lo = loadout ?? (this.ui.selectedWeapons.length === 2 ? [...this.ui.selectedWeapons] : (["pistol", "shotgun"] as WeaponKey[]));
    // mobile: go fullscreen + lock landscape (user-gesture context; best effort)
    if (isTouchDevice) {
      try {
        const p = document.documentElement.requestFullscreen() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch { /* not supported / denied */ }
      try {
        const o = screen.orientation as unknown as { lock?: (o: string) => Promise<void> } | undefined;
        const r = o?.lock?.("landscape");
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch { /* not supported / denied */ }
    }
    if (isExp) {
      this.sim = createGame("deadzone", isTouchDevice, "expedition");
      startExpeditionRun(this.sim, lo, this.stash);
      this.world!.setMap("deadzone", this.sim.obstacles, this.sim.exp);
    } else {
      const map = this.ui.selectedMap;
      this.sim = createGame(map, isTouchDevice);
      startRun(this.sim, lo);
      this.world!.setMap(map, this.sim.obstacles);
    }
    this.world!.clearEnemies();
    this.world!.setGun(lo[0]);
    this.paused = false;
    this.lockWasHeld = false;
    this.runStartT = performance.now();
    this.ui.show("playing");
    if (!isTouchDevice) this.input.lockPointer();
    this.ui.banner(
      isExp ? "DEAD ZONE" : "PROTOCOL ACTIVE",
      isExp ? "LOOT · SURVIVE · EXFIL — DEATH LOSES YOUR CARRY" : "SURVIVE 10 WAVES"
    );
  }

  private toTitle() {
    this.sim = null;
    this.paused = false;
    this.world?.clearEnemies();
    this.ui.show("title");
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private togglePause(force?: boolean) {
    if (!this.sim || this.sim.over || this.sim.won) return;
    this.paused = force ?? !this.paused;
    this.ui.show(this.paused ? "pause" : "playing");
    if (this.paused && document.pointerLockElement) document.exitPointerLock();
    if (!this.paused && !isTouchDevice) this.input.lockPointer();
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.25) dt = 0.25;

    const w = this.world!;
    // touch portrait: game is blocked behind the rotate overlay — freeze the
    // sim but keep rendering so the scene is alive when they rotate back
    const portraitBlocked = this.ui.checkOrientation();
    if (this.sim && this.ui.screen === "playing" && !this.paused && !portraitBlocked) {
      // pause key (Esc / touch pause button)
      if (this.input.input.pausePressed) { this.togglePause(); this.input.endFrame(); return; }
      // Desktop: pointer lock is the only way to look and shoot. If it is
      // lost mid-run (Esc, alt-tab, denial) — or never acquired — the player
      // is left defenseless while zombies keep coming. Auto-pause instead;
      // resuming re-requests lock from the click gesture. A short grace at
      // run start covers the async lock acquisition after DEPLOY.
      if (!isTouchDevice && !this.sim.over && !this.sim.won && !this.noAutoPause) {
        if (this.input.locked) this.lockWasHeld = true;
        else if (this.lockWasHeld || performance.now() - this.runStartT > 5000) {
          this.togglePause(true);
          this.input.endFrame();
          return;
        }
      }
      // fixed-timestep sim
      this.acc += dt;
      let n = 0;
      while (this.acc >= FIXED_DT && n < 5) {
        this.input.pollKeys();
        stepSim(this.sim, this.input.input, FIXED_DT);
        this.acc -= FIXED_DT;
        n++;
      }
      if (n === 5) this.acc = 0;
      this.input.endFrame();

      // events -> audio/world/ui
      for (const ev of this.sim.events) this.handleEvent(ev);
      this.sim.events.length = 0;

      // melee view-model timing
      if (this.meleeReturnT > 0) {
        this.meleeReturnT -= dt;
        if (this.meleeReturnT <= 0 && this.sim) {
          const cur = this.sim.player.loadout[this.sim.player.cur];
          if (cur) w.setGun(cur.key);
        }
      }

      this.ui.updateHUD(this.sim);

      if (this.sim.over || this.sim.won) {
        // Release pointer lock on death/victory: with lock held the cursor
        // is hidden and clicks never reach the TRY AGAIN / PLAY AGAIN
        // buttons, which reads as a stuck death screen.
        if (document.pointerLockElement) document.exitPointerLock();
      }
      if (this.sim.over) {
        if (this.sim.mode === "expedition") {
          // extracted runs already show the end screen from the
          // "extracted" event; death loses the carried loot
          if (!this.sim.exResult?.extracted) this.ui.showExpeditionDeath(this.sim);
        } else {
          this.ui.showGameOver(this.sim);
        }
      } else if (this.sim.won && !(this.sim.mode === "expedition" && this.sim.exResult?.extracted)) {
        this.ui.showVictory(this.sim);
      }

      // Desktop: prompt to (re)capture the mouse whenever the game is live
      // but pointer lock is not held — otherwise clicks silently do nothing.
      // Never over the death/victory screens: the overlay would sit on top
      // of TRY AGAIN and make retry unreachable.
      const live = !this.sim.over && !this.sim.won;
      this.ui.setLockOverlay(live && !this.input.locked);
    } else if (this.ui.screen === "pause" && this.sim) {
      // keep rendering frozen scene; still end frame to swallow edges
      this.input.endFrame();
    } else {
      this.input.endFrame();
    }

    if (this.sim) w.update(dt, this.sim, now / 1000);
    w.render();
  }

  private handleEvent(ev: GameEvent) {
    const w = this.world!;
    const s = this.sim!;
    const a = this.audio;
    switch (ev.t) {
      case "shoot":
        a.shoot(ev.weapon);
        w.fxShoot(ev.weapon);
        break;
      case "reloadStart":
        a.reload();
        w.fxReload();
        break;
      case "reloadDone":
        this.ui.popup("RELOADED", "info");
        break;
      case "dryFire":
        a.dryFire();
        this.ui.popup("RELOAD [R]", "info");
        break;
      case "swap": {
        const cur = s.player.loadout[s.player.cur];
        if (cur) w.setGun(cur.key);
        break;
      }
      case "slideStart":
        a.slideWhoosh();
        w.fxSlide();
        break;
      case "melee":
        a.meleeSwing();
        w.fxMelee();
        this.meleeReturnT = 0.4;
        break;
      case "hitEnemy":
        a.hitFlesh(ev.headshot);
        w.fxBlood(ev.pos.x, ev.pos.y, ev.pos.z, ev.headshot);
        this.ui.hitmarker(ev.killed);
        break;
      case "shieldHit":
        w.fxShieldHit(ev.pos.x, ev.pos.y, ev.pos.z);
        this.ui.popup("SHIELDED — KILL THE ADDS", "info");
        break;
      case "hitWorld":
        w.fxWorldHit(ev.pos.x, ev.pos.y, ev.pos.z);
        break;
      case "enemyDie": {
        a.zombieDie();
        w.fxDeath(ev.pos.x, ev.pos.y, ev.pos.z, IS_BOSS(ev.kind));
        const name = ENEMIES[ev.kind].name;
        this.ui.popup(`+${ev.score} ${ev.headshot ? "HEADSHOT " : ""}${name}`, "score");
        if (IS_BOSS(ev.kind)) {
          this.ui.banner(`${ENEMIES[ev.kind].name} DOWN`, "+1000 BONUS · SUPPLIES INBOUND", 3200);
        }
        break;
      }
      case "playerHit":
        a.playerHurt();
        break;
      case "waveStart":
        a.waveHorn();
        if (ev.finale) {
          a.bossRoar();
          this.ui.banner("WAVE 10 — PROTOCOL OMEGA", "ALL THREE BOSSES · SURVIVE", 3600);
        } else if (ev.boss) {
          a.bossRoar();
          this.ui.banner(`WAVE ${ev.n} — ${BOSS_NAMES[ev.boss] ?? ev.boss}`, "BOSS INBOUND", 3600);
        } else {
          this.ui.banner(`WAVE ${ev.n} INCOMING`, "MIXED HORDE", 2600);
        }
        break;
      case "waveClear":
        this.ui.banner("WAVE CLEARED", "+ SUPPLIES", 2000);
        break;
      case "victory":
        this.ui.banner("CONTAINMENT RESTORED", "", 3000);
        break;
      case "pickup":
        a.pickup();
        w.fxPickup(ev.kind);
        this.ui.popup(ev.kind === "ammo" ? "+AMMO" : "+25 HP", "info");
        break;
      case "bossSlam":
        a.slam();
        w.fxSlam(ev.pos.x, ev.pos.z, ev.radius);
        break;
      case "bossSummon":
        a.bossRoar();
        this.ui.popup(ev.kind === "broodmother" ? "SHE CALLS HER BROOD" : "THE KING CALLS HIS COURT", "info");
        break;
      case "dashTelegraph":
        break; // telegraphs are synced from live sim state in world.update
      case "dashStun":
        w.fxDashStun();
        this.ui.popup("STUNNED — HIT IT NOW", "info");
        break;
      case "groan":
        a.groan();
        break;
      case "lootPickup":
        a.pickup();
        this.ui.popup(
          ev.kind === "scrap" ? `+${ev.amount} SCRAP`
          : ev.kind === "medkit" ? "+1 MEDKIT"
          : ev.kind === "ammo" ? "+AMMO"
          : `+${ev.amount} PART`,
          "score"
        );
        break;
      case "useMedkit":
        a.pickup();
        this.ui.popup("MEDKIT +50 HP", "info");
        break;
      case "flarePopped":
        a.waveHorn();
        this.ui.banner("FLARE POPPED", "SURGE INBOUND — HOLD THE ZONE", 3000);
        break;
      case "exfilReady":
        a.waveHorn();
        this.ui.banner("CHOPPER LANDED", "BOARD NOW — CLOCK IS TICKING", 3000);
        break;
      case "exfilCancelled":
        this.ui.popup("EXFIL CANCELLED", "info");
        break;
      case "extracted":
        // doExtract already banked the loot into localStorage; re-read so the
        // in-memory stash matches instead of clobbering the save on next write
        this.stash = loadStash();
        this.ui.showExpeditionEnd(s, this.stash);
        break;
      case "gameOver":
        break;
    }
  }
}

new Game().boot();
