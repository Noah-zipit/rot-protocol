/**
 * Unified keyboard/mouse + touch input.
 * Produces one InputState per simulation tick; edges are cleared each frame.
 */

export interface InputState {
  moveX: number; // strafe: -1 left .. +1 right
  moveY: number; // forward: -1 back .. +1 forward
  sprint: boolean;
  jumpPressed: boolean;
  slidePressed: boolean;
  fireHeld: boolean;
  reloadPressed: boolean;
  swap1: boolean;
  swap2: boolean;
  meleePressed: boolean;
  pausePressed: boolean;
  lookDX: number;
  lookDY: number;
}

export const isTouchDevice =
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);

function freshInput(): InputState {
  return {
    moveX: 0, moveY: 0, sprint: false,
    jumpPressed: false, slidePressed: false, fireHeld: false,
    reloadPressed: false, swap1: false, swap2: false,
    meleePressed: false, pausePressed: false,
    lookDX: 0, lookDY: 0,
  };
}

export class InputManager {
  input: InputState = freshInput();
  isTouch = isTouchDevice;
  pointerLocked = false;
  onMute: (() => void) | null = null;
  onPauseKey: (() => void) | null = null;

  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;
  private joyActive = false;
  private joyId = -1;
  private joyCX = 0;
  private joyCY = 0;
  private lookId = -1;
  private lookLX = 0;
  private lookLY = 0;
  private sprintToggle = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bind();
    if (this.isTouch) this.bindTouch();
  }

  /** Request pointer lock (desktop). Call from a user gesture. */
  lockPointer() {
    if (this.isTouch) return;
    this.canvas.requestPointerLock();
  }

  get locked() {
    return this.isTouch || this.pointerLocked;
  }

  private bind() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) {
        if (["Space", "KeyC", "ControlLeft"].includes(e.code)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      switch (e.code) {
        case "Space": this.input.jumpPressed = true; e.preventDefault(); break;
        case "KeyC":
        case "ControlLeft": this.input.slidePressed = true; e.preventDefault(); break;
        case "KeyR": this.input.reloadPressed = true; break;
        case "Digit1": this.input.swap1 = true; break;
        case "Digit2": this.input.swap2 = true; break;
        case "KeyV": this.input.meleePressed = true; break;
        case "KeyM": this.onMute?.(); break;
        case "Escape": this.input.pausePressed = true; break;
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked || this.isTouch) return;
      this.input.lookDX += e.movementX;
      this.input.lookDY += e.movementY;
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.pointerLocked || this.isTouch) return;
      if (e.button === 0) this.input.fireHeld = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.input.fireHeld = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Poll held movement keys into moveX/moveY/sprint. Call each tick. */
  pollKeys() {
    if (this.isTouch) return; // touch uses joystick state
    const k = this.keys;
    const x = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const y = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    this.input.moveX = x;
    this.input.moveY = y;
    this.input.sprint = k.has("ShiftLeft") || k.has("ShiftRight");
  }

  /** Clear edge-triggered flags + look deltas at end of frame. */
  endFrame() {
    const i = this.input;
    i.jumpPressed = false; i.slidePressed = false;
    i.reloadPressed = false; i.swap1 = false; i.swap2 = false;
    i.meleePressed = false; i.pausePressed = false;
    i.lookDX = 0; i.lookDY = 0;
  }

  // ---------------- touch ----------------

  private bindTouch() {
    const joy = document.getElementById("joystick")!;
    const knob = document.getElementById("joy-knob")!;
    const JR = 52;

    const setKnob = (dx: number, dy: number) => {
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };

    joy.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.joyActive = true; this.joyId = t.identifier;
      const r = joy.getBoundingClientRect();
      this.joyCX = r.left + r.width / 2; this.joyCY = r.top + r.height / 2;
      this.updateJoy(t.clientX, t.clientY, JR, setKnob);
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId && this.joyActive) {
          this.updateJoy(t.clientX, t.clientY, JR, setKnob);
        } else if (t.identifier === this.lookId) {
          this.input.lookDX += (t.clientX - this.lookLX) * 2.4;
          this.input.lookDY += (t.clientY - this.lookLY) * 2.4;
          this.lookLX = t.clientX; this.lookLY = t.clientY;
        }
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    const endTouch = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          this.joyActive = false; this.joyId = -1;
          this.input.moveX = 0; this.input.moveY = 0;
          setKnob(0, 0);
        }
        if (t.identifier === this.lookId) { this.lookId = -1; }
      }
    };
    window.addEventListener("touchend", endTouch);
    window.addEventListener("touchcancel", endTouch);

    // Right-half drag = look. Attached to canvas so UI buttons still work.
    this.canvas.addEventListener("touchstart", (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX > window.innerWidth * 0.4 && this.lookId === -1) {
          this.lookId = t.identifier;
          this.lookLX = t.clientX; this.lookLY = t.clientY;
        }
      }
    }, { passive: true });

    const hold = (id: string, down: () => void, up?: () => void) => {
      const el = document.getElementById(id)!;
      el.addEventListener("touchstart", (e) => { e.preventDefault(); down(); }, { passive: false });
      el.addEventListener("touchend", (e) => { e.preventDefault(); up?.(); }, { passive: false });
    };

    hold("btn-fire", () => { this.input.fireHeld = true; }, () => { this.input.fireHeld = false; });
    hold("btn-jump", () => { this.input.jumpPressed = true; });
    hold("btn-slide", () => { this.input.slidePressed = true; });
    hold("btn-reload", () => { this.input.reloadPressed = true; });
    hold("btn-melee", () => { this.input.meleePressed = true; });
    hold("btn-swap", () => {
      // alternate between the two loadout slots
      this.swapToggle = !this.swapToggle;
      if (this.swapToggle) this.input.swap2 = true; else this.input.swap1 = true;
    });
    hold("btn-pause-t", () => { this.input.pausePressed = true; });
    hold("btn-mute", () => { this.onMute?.(); });
    const sprintBtn = document.getElementById("btn-sprint")!;
    sprintBtn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.sprintToggle = !this.sprintToggle;
      sprintBtn.classList.toggle("on", this.sprintToggle);
      this.input.sprint = this.sprintToggle;
    }, { passive: false });
  }

  private swapToggle = false;

  private updateJoy(cx: number, cy: number, jr: number, setKnob: (dx: number, dy: number) => void) {
    let dx = cx - this.joyCX;
    let dy = cy - this.joyCY;
    const len = Math.hypot(dx, dy);
    if (len > jr) { dx = dx / len * jr; dy = dy / len * jr; }
    setKnob(dx, dy);
    const nx = dx / jr, ny = dy / jr;
    this.input.moveX = Math.abs(nx) < 0.15 ? 0 : nx;
    this.input.moveY = Math.abs(ny) < 0.15 ? 0 : -ny;
  }
}
