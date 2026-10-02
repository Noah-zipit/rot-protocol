/**
 * 100% procedural WebAudio SFX — no audio assets.
 * Context is created lazily on first user gesture.
 */

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  private lastGroan = 0;

  /** Must be called from a user gesture at least once. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    // 1s of white noise, reused by everything percussive
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime);
    }
    return this.muted;
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, gain: number, when = 0, sweepTo?: number) {
    if (!this.ctx || !this.master || !this.noiseBuf || this.muted) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType; f.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0, slideTo?: number) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  shoot(kind: string) {
    switch (kind) {
      case "pistol":
        this.noise(0.12, "highpass", 900, 0.5);
        this.tone(220, 0.08, "square", 0.25, 0, 90);
        break;
      case "shotgun":
        this.noise(0.35, "lowpass", 1400, 0.9, 0, 120);
        this.tone(110, 0.25, "sine", 0.6, 0, 40);
        break;
      case "smg":
        this.noise(0.08, "bandpass", 2400, 0.4);
        this.tone(330, 0.05, "square", 0.2, 0, 140);
        break;
      case "rifle":
        this.noise(0.4, "lowpass", 2200, 0.8, 0, 100);
        this.tone(150, 0.3, "sawtooth", 0.35, 0, 45);
        break;
    }
  }

  dryFire() { this.tone(1400, 0.05, "square", 0.15); }
  reload() { this.tone(700, 0.05, "square", 0.2); this.tone(500, 0.06, "square", 0.25, 0.18); }
  meleeSwing() { this.noise(0.18, "bandpass", 1800, 0.3, 0, 400); }

  hitFlesh(headshot: boolean) {
    this.tone(200, 0.1, "sine", 0.5, 0, 70);
    this.noise(0.08, "lowpass", 800, 0.35);
    if (headshot) this.tone(2400, 0.12, "triangle", 0.3, 0.02, 3600);
  }

  zombieDie() {
    this.tone(130, 0.5, "sawtooth", 0.28, 0, 45);
    this.noise(0.3, "lowpass", 500, 0.3, 0.05, 100);
  }

  groan() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastGroan < 1.2) return;
    this.lastGroan = now;
    const f = 70 + Math.random() * 50;
    this.tone(f, 0.7, "sawtooth", 0.12, 0, f * 0.6);
  }

  playerHurt() {
    this.tone(90, 0.25, "sine", 0.7, 0, 40);
    this.noise(0.2, "lowpass", 400, 0.4);
  }

  waveHorn() {
    this.tone(98, 1.2, "sawtooth", 0.3);
    this.tone(147, 1.2, "sawtooth", 0.22, 0.05);
  }

  bossRoar() {
    this.tone(60, 1.4, "sawtooth", 0.5, 0, 35);
    this.noise(1.0, "lowpass", 300, 0.4, 0.1, 80);
  }

  slam() {
    this.noise(0.5, "lowpass", 900, 0.9, 0, 60);
    this.tone(55, 0.5, "sine", 0.8, 0, 30);
  }

  slideWhoosh() { this.noise(0.35, "bandpass", 1200, 0.3, 0, 300); }
  pickup() { this.tone(660, 0.07, "square", 0.2); this.tone(990, 0.09, "square", 0.2, 0.07); }
  uiClick() { this.tone(880, 0.05, "square", 0.15); }
}
