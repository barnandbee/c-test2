/**
 * Audio.js — a tiny procedural sound engine built entirely on the Web
 * Audio API. No sample files: every effect is synthesised at runtime, so
 * the game stays a zero-asset, zero-build static site that works offline.
 *
 * One-shots (jump bounce, collection sparkle, unlock slide-whistle, trophy
 * chime) are fired with play(name). Vehicles get continuous, looping beds
 * (hovercraft whir, balloon burner, rocket roar) driven by setVehicle(kind),
 * which crossfades cleanly between engines and to silence.
 *
 * Browsers forbid audio until a user gesture, so the context starts
 * suspended and resume() is wired to the first click / key / touch.
 */
export class SoundFX {
  constructor() {
    /** @type {AudioContext|null} lazily created on the first gesture */
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noiseBuffer = null;
    this._vehicle = null;       // { kind, nodes:[], gain } | null
    this._armed = false;
  }

  /* ---------------- lifecycle ---------------- */

  /** Create (once) and resume the context. Safe to call repeatedly. */
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return; // no Web Audio — degrade silently
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * Wire a one-time gesture listener that unlocks audio the first time
   * the player touches the page (autoplay policy compliance).
   */
  armOnGesture() {
    if (this._armed) return;
    this._armed = true;
    const unlock = () => this.resume();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, unlock, { passive: true });
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, now, 0.02);
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /* ---------------- helpers ---------------- */

  /** A shared 2-second white-noise buffer for airy / roaring beds. */
  _noise() {
    if (!this._noiseBuffer) {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuffer = buf;
    }
    return this._noiseBuffer;
  }

  /** One-shot oscillator with an ADSR-ish gain envelope. */
  _blip(type, freqStart, freqEnd, t0, dur, peak, dest) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t0);
    if (freqEnd !== freqStart) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest || this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    return osc;
  }

  /* ---------------- one-shots ---------------- */

  /** Public entry point for a named one-shot. */
  play(name, variant = 0) {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    switch (name) {
      case 'jump': return this._jump();
      case 'collect': return this._collect(variant >= 1);
      case 'unlock': return this._unlock();
      case 'trophy': return this._trophy();
      default: return;
    }
  }

  /** A springy cartoon bounce: a quick upward pitch bend with a wobble. */
  _jump() {
    const t = this.ctx.currentTime;
    this._blip('triangle', 210, 560, t, 0.16, 0.28);
    // A tiny second harmonic tick gives it a rubbery 'boing' snap.
    this._blip('sine', 420, 900, t + 0.005, 0.12, 0.12);
  }

  /** Sparkles for a pickup: a bright three-note arpeggio plus shimmer. */
  _collect(grand) {
    const t = this.ctx.currentTime;
    const notes = grand ? [784, 1175, 1568, 2093] : [988, 1319, 1760];
    notes.forEach((f, i) => {
      this._blip('triangle', f, f, t + i * 0.05, 0.18, grand ? 0.22 : 0.18);
    });
    // A whisper of filtered noise as fairy-dust on top.
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = grand ? 6500 : 5200;
    bp.Q.value = 2.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(grand ? 0.09 : 0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (grand ? 0.4 : 0.28));
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.45);
  }

  /** A classic rising slide-whistle for unlocking something. */
  _unlock() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    // Smooth portamento up the register, then a little flick over the top.
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.45);
    osc.frequency.exponentialRampToValueAtTime(1250, t + 0.6);
    // Gentle vibrato for that airy whistle character.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 11;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(osc.frequency);
    // A resonant bandpass makes it read as breath, not a pure tone.
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.05);
    g.gain.setValueAtTime(0.3, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    osc.connect(bp).connect(g).connect(this.master);
    osc.start(t); lfo.start(t);
    osc.stop(t + 0.75); lfo.stop(t + 0.75);
  }

  /** A short, satisfying two-note chime for earning a trophy. */
  _trophy() {
    const t = this.ctx.currentTime;
    this._blip('triangle', 1047, 1047, t, 0.2, 0.2);       // C6
    this._blip('triangle', 1568, 1568, t + 0.11, 0.28, 0.2); // G6
  }

  /* ---------------- vehicle beds ---------------- */

  /**
   * Set the currently-riding vehicle: 'hovercraft' | 'balloon' | 'rocket'
   * | null. Crossfades the previous bed out and the new one in.
   */
  setVehicle(kind) {
    if (!this.ctx || this.ctx.state !== 'running') { this._pendingVehicle = kind; return; }
    if (this._vehicle && this._vehicle.kind === kind) return;
    this._stopVehicle();
    if (!kind) return;
    if (kind === 'hovercraft') this._vehicle = this._hovercraftBed();
    else if (kind === 'balloon') this._vehicle = this._balloonBed();
    else if (kind === 'rocket') this._vehicle = this._rocketBed();
    if (this._vehicle) this._vehicle.kind = kind;
  }

  _stopVehicle() {
    const v = this._vehicle;
    this._vehicle = null;
    if (!v) return;
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    for (const n of v.nodes) {
      try { n.stop(t + 0.3); } catch (e) { /* gain nodes have no stop */ }
    }
  }

  /** Low hovering whir: filtered saw with a slow wobble and airy hiss. */
  _hovercraftBed() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.16, t + 0.3);
    out.connect(this.master);

    const saw = this.ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 92;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 6;
    // Wobble the cutoff so the engine hums and pulses.
    const wob = this.ctx.createOscillator();
    wob.frequency.value = 5.5;
    const wobGain = this.ctx.createGain();
    wobGain.gain.value = 120;
    wob.connect(wobGain).connect(lp.frequency);
    saw.connect(lp).connect(out);

    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this._noise();
    hiss.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1400;
    hp.Q.value = 0.7;
    const hissGain = this.ctx.createGain();
    hissGain.gain.value = 0.5;
    hiss.connect(hp).connect(hissGain).connect(out);

    saw.start(t); wob.start(t); hiss.start(t);
    return { nodes: [saw, wob, hiss], gain: out };
  }

  /** Soft hot-air balloon: warm drone under a gentle burner hiss. */
  _balloonBed() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.14, t + 0.4);
    out.connect(this.master);

    const drone = this.ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 62;
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.5;
    drone.connect(droneGain).connect(out);

    // Burner: bandpassed noise that swells and fades like intermittent flame.
    const flame = this.ctx.createBufferSource();
    flame.buffer = this._noise();
    flame.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.8;
    const flameGain = this.ctx.createGain();
    flameGain.gain.value = 0.35;
    // Slow LFO breathes the flame in and out.
    const breath = this.ctx.createOscillator();
    breath.type = 'sine';
    breath.frequency.value = 0.5;
    const breathGain = this.ctx.createGain();
    breathGain.gain.value = 0.28;
    breath.connect(breathGain).connect(flameGain.gain);
    flame.connect(bp).connect(flameGain).connect(out);

    drone.start(t); flame.start(t); breath.start(t);
    return { nodes: [drone, flame, breath], gain: out };
  }

  /** Loud rocket roar: heavy low-passed noise over a rumbling sub-oscillator. */
  _rocketBed() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.28, t + 0.15);
    out.connect(this.master);

    const roar = this.ctx.createBufferSource();
    roar.buffer = this._noise();
    roar.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 1.2;
    const roarGain = this.ctx.createGain();
    roarGain.gain.value = 0.8;
    roar.connect(lp).connect(roarGain).connect(out);

    // A detuned sub-oscillator adds body and a crackling rumble.
    const sub = this.ctx.createOscillator();
    sub.type = 'sawtooth';
    sub.frequency.value = 55;
    const subLp = this.ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    subLp.frequency.value = 200;
    const rumble = this.ctx.createOscillator();
    rumble.frequency.value = 24;
    const rumbleGain = this.ctx.createGain();
    rumbleGain.gain.value = 30;
    rumble.connect(rumbleGain).connect(sub.frequency);
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.35;
    sub.connect(subLp).connect(subGain).connect(out);

    roar.start(t); sub.start(t); rumble.start(t);
    return { nodes: [roar, sub, rumble], gain: out };
  }

  /** Silence everything (e.g. on game over). */
  stopAll() {
    this._stopVehicle();
    this._pendingVehicle = null;
  }
}
