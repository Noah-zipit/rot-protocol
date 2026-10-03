/**
 * ROT PROTOCOL — DOM UI layer. HUD, screens, loadout, map select, boss bars.
 * All styling lives in style.css; this module only wires logic + text.
 */
import { WEAPONS, ENEMIES, type WeaponKey, type GameState, type UpgradeLevels, MAX_WAVE } from "./sim";
import { UPGRADE_DEFS, compassMarkers, type Stash } from "./expedition";
import { isTouchDevice } from "./input";

export type ScreenName = "loading" | "title" | "loadout" | "stash" | "playing" | "pause" | "over" | "victory";

export class UI {
  isTouch = isTouchDevice;
  screen: ScreenName = "loading";
  selectedMap: "graveyard" | "city" = "graveyard";
  gameMode: "wave" | "expedition" = "wave";
  selectedWeapons: WeaponKey[] = [];
  onMode: ((mode: "wave" | "expedition") => void) | null = null;
  onDeploy: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onLockClick: (() => void) | null = null;
  onQuality: ((mode: string) => void) | null = null;
  onStash: (() => void) | null = null;
  onStashBack: (() => void) | null = null;
  onBuyUpgrade: ((key: keyof UpgradeLevels) => void) | null = null;

  private el = (id: string) => document.getElementById(id)!;
  private bannerTimer = 0;
  private lastBossKey = "";

  constructor() {
    this.buildLoadout();
    this.buildMapSelect();
    this.el("btn-mode-waves").addEventListener("click", () => this.selectMode("wave"));
    this.el("btn-mode-expedition").addEventListener("click", () => this.selectMode("expedition"));
    this.el("btn-stash").addEventListener("click", () => this.onStash?.());
    this.el("btn-stash-back").addEventListener("click", () => this.onStashBack?.());
    this.el("btn-deploy").addEventListener("click", () => this.onDeploy?.());
    this.el("btn-resume").addEventListener("click", () => this.onResume?.());
    this.el("btn-quit").addEventListener("click", () => this.onQuit?.());
    this.el("btn-restart").addEventListener("click", () => this.onRestart?.());
    this.el("btn-again").addEventListener("click", () => this.onRestart?.());
    this.el("lock-overlay").addEventListener("click", () => this.onLockClick?.());
    this.el("lock-box").addEventListener("click", () => this.onLockClick?.());
    // pause-screen quality selector
    this.el("quality-row").querySelectorAll(".qbtn").forEach((b) => {
      b.addEventListener("click", () => {
        const m = (b as HTMLElement).dataset.q ?? "auto";
        this.setQualityMode(m);
        this.onQuality?.(m);
      });
    });
    // touch note vs controls list
    if (this.isTouch) {
      this.el("touch-note").classList.remove("hidden");
      this.el("touch-ui").classList.remove("hidden");
    } else {
      this.el("controls-list").classList.remove("hidden");
    }
  }

  /** Title-screen mode pick: waves keep the map select, expedition is fixed. */
  private selectMode(mode: "wave" | "expedition") {
    this.gameMode = mode;
    this.el("map-select").classList.toggle("hidden", mode === "expedition");
    this.onMode?.(mode);
  }

  private buildMapSelect() {
    const wrap = this.el("map-select");
    wrap.innerHTML = "";
    const maps = [
      { key: "graveyard", label: "GRAVEYARD", desc: "Open. Scattered cover." },
      { key: "city", label: "CITY", desc: "Tight streets. Hard cover." },
    ] as const;
    for (const m of maps) {
      const b = document.createElement("button");
      b.className = "map-card" + (m.key === this.selectedMap ? " selected" : "");
      b.innerHTML = `<span class="map-name">${m.label}</span><span class="map-desc">${m.desc}</span>`;
      b.addEventListener("click", () => {
        this.selectedMap = m.key;
        wrap.querySelectorAll(".map-card").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
      });
      wrap.appendChild(b);
    }
  }

  private buildLoadout() {
    const grid = this.el("loadout-grid");
    grid.innerHTML = "";
    const keys: WeaponKey[] = ["pistol", "shotgun", "smg", "rifle"];
    for (const k of keys) {
      const d = WEAPONS[k];
      const card = document.createElement("button");
      card.className = "weapon-card";
      card.dataset.key = k;
      card.innerHTML = `
        <span class="w-name">${d.name}</span>
        <span class="w-desc">${d.desc}</span>
        <span class="w-stats">DMG ${d.damage} · MAG ${d.mag} · ${d.reserve < 0 ? "INF" : d.reserve} RSV</span>`;
      card.addEventListener("click", () => this.toggleWeapon(k, card));
      grid.appendChild(card);
    }
  }

  private toggleWeapon(k: WeaponKey, card: HTMLButtonElement) {
    const i = this.selectedWeapons.indexOf(k);
    if (i >= 0) {
      this.selectedWeapons.splice(i, 1);
      card.classList.remove("selected");
    } else if (this.selectedWeapons.length < 2) {
      this.selectedWeapons.push(k);
      card.classList.add("selected");
    }
    (this.el("btn-deploy") as HTMLButtonElement).disabled = this.selectedWeapons.length !== 2;
  }

  resetLoadout() {
    this.selectedWeapons = [];
    this.el("loadout-grid").querySelectorAll(".weapon-card").forEach((x) => x.classList.remove("selected"));
    (this.el("btn-deploy") as HTMLButtonElement).disabled = true;
  }

  show(name: ScreenName) {
    this.screen = name;
    for (const s of ["loading", "title", "loadout", "stash", "pause", "over", "victory"] as const) {
      this.el(`screen-${s}`).classList.toggle("hidden", s !== name);
    }
    this.el("hud").classList.toggle("hidden", name !== "playing" && name !== "pause");
    if (name === "playing" && !this.isTouch) this.el("touch-ui").classList.add("hidden");
    if (name !== "playing") this.el("banner").classList.add("hidden");
    if (name !== "playing") this.el("lock-overlay").classList.add("hidden");
  }

  // ---------- HUD ----------

  updateHUD(s: GameState) {
    const p = s.player;
    const w = p.loadout[p.cur];
    this.el("health-bar").style.width = `${Math.max(0, p.hp)}%`;
    this.el("health-num").textContent = `${Math.ceil(Math.max(0, p.hp))}`;
    this.el("health-bar").classList.toggle("low", p.hp < 30);
    if (w) {
      const d = WEAPONS[w.key];
      this.el("weapon-name").textContent = d.name;
      this.el("ammo").textContent = `${w.mag} / ${w.reserve < 0 ? "INF" : w.reserve}${w.reloading ? " RLD" : ""}`;
      this.el("ammo").classList.toggle("reloading", w.reloading);
    }
    const remaining = s.spawnQueue.length + s.enemies.filter((e) => !e.dead).length;
    this.el("wave-label").textContent = s.wave === 0 ? "STANDBY" : `WAVE ${s.wave}/${MAX_WAVE}`;
    this.el("zombies-left").textContent = `HOSTILES ${remaining}`;
    this.el("score").textContent = `SCORE ${s.score}`;
    this.el("kills").textContent = `KILLS ${s.kills}`;
    this.el("slide-indicator").classList.toggle("hidden", !p.sliding);

    // ---- expedition HUD: loot counters, compass, exfil ----
    const isExp = s.mode === "expedition" && s.exp !== null;
    this.el("compass").classList.toggle("hidden", !isExp);
    this.el("loot-bar").classList.toggle("hidden", !isExp);
    // touch USE / MED buttons are expedition-only
    for (const id of ["btn-interact", "btn-medkit"]) {
      const b = document.getElementById(id);
      if (b) b.style.display = isExp ? "" : "none";
    }
    if (isExp) {
      const ex = s.exp!;
      const c = ex.carried;
      this.el("wave-label").textContent = "DEAD ZONE";
      this.el("loot-scrap").textContent = `SCRAP ${c.scrap}`;
      this.el("loot-meds").textContent = `MEDS ${c.medkits}/3`;
      this.el("loot-parts").textContent = `PARTS ${c.parts}`;
      this.updateCompass(s);

      const dEx = Math.hypot(ex.exfilPos.x - p.pos.x, ex.exfilPos.z - p.pos.z);
      const st = this.el("exfil-status");
      st.classList.remove("hidden");
      if (ex.exfil === "called") {
        st.textContent = `SURGE ${Math.ceil(ex.exfilT)}s — HOLD THE ZONE`;
        st.classList.add("hot");
      } else if (ex.exfil === "landed") {
        st.textContent = `CHOPPER WAITING ${Math.ceil(ex.boardT)}s — BOARD NOW`;
        st.classList.add("hot");
      } else {
        st.textContent = "REACH EXFIL TO CALL THE CHOPPER";
        st.classList.remove("hot");
      }

      const ip = this.el("interact-prompt");
      const useKey = this.isTouch ? "TAP USE" : "PRESS E";
      if (ex.exfil === "idle" && dEx < 7) {
        ip.textContent = `${useKey} — POP FLARE`;
        ip.classList.remove("hidden");
      } else if (ex.exfil === "landed" && dEx < 12) {
        ip.textContent = "GET IN THE ZONE";
        ip.classList.remove("hidden");
      } else {
        ip.classList.add("hidden");
      }

      const edge = Math.abs(p.pos.x) > s.half - 8 || Math.abs(p.pos.z) > s.half - 8;
      this.el("edge-warning").classList.toggle("hidden", !edge);
    } else {
      this.el("exfil-status").classList.add("hidden");
      this.el("interact-prompt").classList.add("hidden");
      this.el("edge-warning").classList.add("hidden");
    }

    // crosshair spread
    const spread = 4 + p.moveSpeed * 1.6 + (w ? WEAPONS[w.key].kick * 40 : 0);
    this.el("crosshair").style.setProperty("--spread", `${spread}px`);

    // damage vignette
    const v = this.el("damage-vignette");
    const since = s.time - p.lastDamageT;
    v.style.opacity = since < 0.6 ? `${0.85 * (1 - since / 0.6)}` : "0";

    // boss bars (rebuild only when the set or HP changes meaningfully)
    const barWrap = this.el("boss-bars");
    const bosses = s.enemies.filter((e) => !e.dead && (e.kind === "rotking" || e.kind === "ripper" || e.kind === "broodmother"));
    const key = bosses.slice(0, 3).map((b) => `${b.id}:${Math.round(b.hp / b.maxHp * 50)}`).join("|");
    if (key !== this.lastBossKey) {
      this.lastBossKey = key;
      barWrap.innerHTML = "";
      for (const b of bosses.slice(0, 3)) {
        const div = document.createElement("div");
        div.className = "boss-bar";
        const pct = Math.max(0, (b.hp / b.maxHp) * 100);
        div.innerHTML = `<span class="boss-name">${ENEMIES[b.kind].name}</span>
          <div class="boss-hp-track"><div class="boss-hp" style="width:${pct}%"></div></div>`;
        barWrap.appendChild(div);
      }
    }
  }

  banner(text: string, sub: string, ms = 2600) {
    const b = this.el("banner");
    b.innerHTML = `<div class="banner-main">${text}</div><div class="banner-sub">${sub}</div>`;
    b.classList.remove("hidden");
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.add("hidden"), ms);
  }

  hitmarker(killed: boolean) {
    const h = this.el("hitmarker");
    h.classList.remove("show", "kill");
    void h.offsetWidth;
    h.classList.add("show");
    if (killed) h.classList.add("kill");
  }

  popup(text: string, kind: "score" | "info" = "score") {
    const wrap = this.el("popups");
    if (wrap.children.length > 12) wrap.removeChild(wrap.firstChild!);
    const d = document.createElement("div");
    d.className = `popup ${kind}`;
    d.textContent = text;
    d.style.left = `${38 + Math.random() * 24}%`;
    d.style.top = `${36 + Math.random() * 16}%`;
    wrap.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  private compassTick = 0;

  /** Compass strip: cardinal ticks + objective markers, ~8fps rebuild. */
  private updateCompass(s: GameState) {
    if ((this.compassTick++ & 7) !== 0) return;
    const RANGE = 1.31; // ±75 degrees
    let html = "";
    const cards: Array<[string, number]> = [["N", 0], ["E", -Math.PI / 2], ["S", Math.PI], ["W", Math.PI / 2]];
    for (const [label, yawT] of cards) {
      let rel = yawT - s.player.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) < RANGE) {
        html += `<span class="cm-card" style="left:${(50 + (rel / RANGE) * 48).toFixed(1)}%">${label}</span>`;
      }
    }
    for (const m of compassMarkers(s)) {
      if (Math.abs(m.rel) < RANGE) {
        html += `<span class="cm-mark ${m.cls}" style="left:${(50 + (m.rel / RANGE) * 48).toFixed(1)}%">${m.label}</span>`;
      }
    }
    this.el("compass-strip").innerHTML = html;
  }

  /** Stash & upgrades screen. */
  renderStash(stash: Stash) {
    this.el("stash-stats").innerHTML =
      `<div>SCRAP <b>${stash.scrap}</b></div>` +
      `<div>WEAPON PARTS <b>${stash.parts}</b></div>` +
      `<div>EXTRACTIONS <b>${stash.best.extracts}</b></div>` +
      `<div>BEST HAUL <b>${stash.best.scrap}</b></div>`;
    const list = this.el("upgrade-list");
    list.innerHTML = "";
    for (const def of UPGRADE_DEFS) {
      const cur = stash.upgrades[def.key];
      const maxed = cur >= def.max;
      const cost = maxed ? null : def.cost(cur + 1);
      const afford = cost !== null && stash.scrap >= cost.scrap && stash.parts >= cost.parts;
      const row = document.createElement("div");
      row.className = "upgrade-row";
      row.innerHTML =
        `<div class="u-info"><span class="u-name">${def.name} <span class="u-tier">${cur}/${def.max}</span></span>` +
        `<span class="u-desc">${def.desc} · ${def.effect(Math.max(cur, 1))}</span></div>`;
      const btn = document.createElement("button");
      btn.className = "btn btn-small" + (afford ? "" : " btn-dim");
      btn.disabled = maxed || !afford;
      btn.textContent = maxed
        ? "MAXED"
        : `BUY · ${cost!.scrap} SCRAP${cost!.parts ? ` + ${cost!.parts} PART${cost!.parts > 1 ? "S" : ""}` : ""}`;
      btn.addEventListener("click", () => this.onBuyUpgrade?.(def.key));
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  showGameOver(s: GameState) {
    this.el("over-title").textContent = "YOU DIED";
    this.el("over-sub").textContent = "THE ROT TAKES ANOTHER";
    this.el("final-stats").innerHTML =
      `<div>SCORE <b>${s.score}</b></div>` +
      `<div>WAVE <b>${s.wave}/${MAX_WAVE}</b></div>` +
      `<div>KILLS <b>${s.kills}</b></div>`;
    this.show("over");
  }

  /** Expedition: extracted — loot banked, stash totals. */
  showExpeditionEnd(s: GameState, stash: Stash) {
    const ex = s.exp!;
    const mins = Math.floor(s.time / 60);
    const secs = Math.floor(s.time % 60).toString().padStart(2, "0");
    this.el("victory-title").textContent = "EXTRACTED";
    this.el("victory-sub").textContent = "LOOT SECURED IN THE STASH";
    this.el("victory-stats").innerHTML =
      `<div>SCRAP BANKED <b>+${ex.carried.scrap}</b></div>` +
      `<div>PARTS BANKED <b>+${ex.carried.parts}</b></div>` +
      `<div>STASH <b>${stash.scrap} SCRAP · ${stash.parts} PARTS</b></div>` +
      `<div>KILLS <b>${s.kills}</b></div>` +
      `<div>TIME <b>${mins}:${secs}</b></div>`;
    this.show("victory");
  }

  /** Expedition: died — carried loot is gone, the stash survives. */
  showExpeditionDeath(s: GameState) {
    const ex = s.exp!;
    const mins = Math.floor(s.time / 60);
    const secs = Math.floor(s.time % 60).toString().padStart(2, "0");
    this.el("over-title").textContent = "KIA — LOOT LOST";
    this.el("over-sub").textContent = "THE STASH SURVIVES. YOUR CARRY DOES NOT.";
    this.el("final-stats").innerHTML =
      `<div>SCRAP LOST <b>${ex.carried.scrap}</b></div>` +
      `<div>PARTS LOST <b>${ex.carried.parts}</b></div>` +
      `<div>KILLS <b>${s.kills}</b></div>` +
      `<div>TIME <b>${mins}:${secs}</b></div>`;
    this.show("over");
  }

  showVictory(s: GameState) {
    this.el("victory-title").textContent = "CONTAINMENT RESTORED";
    this.el("victory-sub").textContent = "ALL 10 WAVES SURVIVED";
    const mins = Math.floor(s.time / 60);
    const secs = Math.floor(s.time % 60).toString().padStart(2, "0");
    const acc = s.shotsFired > 0 ? Math.round((s.shotsHit / s.shotsFired) * 100) : 0;
    this.el("victory-stats").innerHTML =
      `<div>SCORE <b>${s.score}</b></div>` +
      `<div>TIME <b>${mins}:${secs}</b></div>` +
      `<div>KILLS <b>${s.kills}</b></div>` +
      `<div>ACCURACY <b>${acc}%</b></div>`;
    this.show("victory");
  }

  setLoading(pct: number, label: string) {
    this.el("loading-label").textContent = `${label} ${Math.round(pct * 100)}%`;
  }

  /**
   * Landscape enforcement on touch devices: in portrait the game is blocked
   * behind a fullscreen rotate overlay. Returns true when blocked.
   */
  checkOrientation(): boolean {
    const blocked = this.isTouch && window.innerHeight > window.innerWidth;
    this.el("rotate-overlay").classList.toggle("hidden", !blocked);
    return blocked;
  }

  /**
   * Desktop pointer-lock prompt: shown whenever the game is live but pointer
   * lock is not held (request denied, lost via ESC, never acquired). Without
   * it, clicks silently do nothing — no look, no fire, no prompt.
   */
  setLockOverlay(visible: boolean) {
    this.el("lock-overlay").classList.toggle("hidden", !visible);
  }

  /** Reflect the active quality tier on the pause-screen selector. */
  setQualityMode(mode: string) {
    this.el("quality-row").querySelectorAll(".qbtn").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.q === mode);
    });
  }
}
