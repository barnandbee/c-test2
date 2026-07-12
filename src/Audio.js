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
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().then(() => this.startMusic()).catch(() => {});
    } else if (this.ctx.state === 'running') {
      this.startMusic();
    }
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
      case 'bugle': return this._bugle();
      case 'ticks': return this._ticks();
      case 'sonar': return this._sonar();
      case 'squelch': return this._squelch();
      case 'train': return this._train();
      case 'win': return this._win();
      case 'ribbit': return this._ribbit();
      case 'carthorn': return this._carthorn();
      case 'select': return this._select();
      default: return;
    }
  }

  /** A soft UI pip for flipping between character choices. */
  _select() {
    const t = this.ctx.currentTime;
    this._blip('triangle', 660, 990, t, 0.09, 0.14);
    this._blip('sine', 1320, 1320, t + 0.01, 0.07, 0.05);
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

  /** A brassy little bugle 'charge!' fanfare for the Magna Carta. */
  _bugle() {
    const t = this.ctx.currentTime;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.connect(this.master);
    // G4 C5 E5 — G5, the classic cavalry call, last note held & vibra'd.
    const notes = [[392, 0.0, 0.12], [523, 0.12, 0.12], [659, 0.24, 0.12], [784, 0.38, 0.5]];
    for (const [f, dt, dur] of notes) {
      this._blip('sawtooth', f, f, t + dt, dur, 0.22, lp);
      this._blip('square', f, f, t + dt, dur, 0.05, lp); // reedy edge
    }
  }

  /** A little run of clock ticks — time has been added. */
  _ticks(n = 5) {
    const t = this.ctx.currentTime;
    for (let i = 0; i < n; i++) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise();
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = i % 2 ? 2600 : 2000; // tick… tock…
      bp.Q.value = 8;
      const g = this.ctx.createGain();
      const at = t + i * 0.11;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.16, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      src.connect(bp).connect(g).connect(this.master);
      src.start(at);
      src.stop(at + 0.06);
    }
  }

  /** A deep sonar ping + metallic clang for striking the submarine. */
  _sonar() {
    const t = this.ctx.currentTime;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(this.master);
    // The ping: a pure tone with a long, watery decay.
    const ping = this.ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.setValueAtTime(720, t);
    ping.frequency.exponentialRampToValueAtTime(660, t + 0.5);
    const pg = this.ctx.createGain();
    pg.gain.setValueAtTime(0.0001, t);
    pg.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    pg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    ping.connect(pg).connect(lp);
    ping.start(t); ping.stop(t + 1.15);
    // A dull hull clang underneath.
    this._blip('square', 150, 90, t, 0.35, 0.16, lp);
    this._blip('triangle', 226, 140, t, 0.3, 0.1, lp);
  }

  /** A wet mayonnaise squelch for dressing the sandwich. */
  _squelch() {
    const t = this.ctx.currentTime;
    // Bandpassed noise whose filter sweeps down — a gloopy splat.
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.28);
    bp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.36);
    // A low 'blop' that drops in pitch, the last squeeze from the jar.
    this._blip('sine', 300, 90, t + 0.02, 0.26, 0.16);
  }

  /** A departing-train motif: a two-tone horn over accelerating chuffs. */
  _train() {
    const t = this.ctx.currentTime;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    lp.connect(this.master);
    // Two-tone horn (a falling minor third), held.
    for (const [f, g] of [[330, 0.14], [262, 0.14]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(g, t + 0.08);
      og.gain.setValueAtTime(g, t + 0.6);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(og).connect(lp);
      o.start(t); o.stop(t + 0.95);
    }
    // Chuffs: filtered-noise puffs that speed up as the train pulls away.
    let ct = t;
    for (let i = 0; i < 6; i++) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise();
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500;
      bp.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, ct);
      g.gain.exponentialRampToValueAtTime(0.14, ct + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ct + 0.14);
      src.connect(bp).connect(g).connect(this.master);
      src.start(ct); src.stop(ct + 0.16);
      ct += 0.22 - i * 0.02; // accelerate
    }
  }

  /** A bright ascending fanfare for winning Veggie Tac Toe. */
  _win() {
    const t = this.ctx.currentTime;
    const notes = [523, 659, 784, 1047]; // C E G C
    notes.forEach((f, i) => this._blip('triangle', f, f, t + i * 0.1, 0.26, 0.2));
    // A sparkle flourish on top.
    this._blip('triangle', 1568, 1568, t + 0.44, 0.3, 0.16);
    this._blip('sine', 2093, 2093, t + 0.5, 0.3, 0.1);
  }

  /** A wet, croaky frog ribbit for a toxic-frog collision. */
  _ribbit() {
    const t = this.ctx.currentTime;
    // Two croaks: a low warble whose pitch bobs, through a resonant lowpass.
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 6;
    lp.connect(this.master);
    for (const start of [0, 0.16]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const a = t + start;
      o.frequency.setValueAtTime(150, a);
      o.frequency.linearRampToValueAtTime(230, a + 0.06);
      o.frequency.linearRampToValueAtTime(120, a + 0.12);
      // Fast amplitude flutter gives the croak its gravel.
      const flutter = this.ctx.createOscillator();
      flutter.frequency.value = 45;
      const flutterGain = this.ctx.createGain();
      flutterGain.gain.value = 0.35;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, a);
      g.gain.exponentialRampToValueAtTime(0.28, a + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a + 0.13);
      flutter.connect(flutterGain).connect(g.gain);
      o.connect(g).connect(lp);
      o.start(a); o.stop(a + 0.15);
      flutter.start(a); flutter.stop(a + 0.15);
    }
  }

  /** A cartoon 'beep beep' car horn for the golf-cart hit. */
  _carthorn() {
    const t = this.ctx.currentTime;
    // Two quick honks — a stacked major-third dyad, square-wave brash.
    for (const start of [0, 0.18]) {
      for (const f of [440, 554]) {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        const a = t + start;
        g.gain.setValueAtTime(0.0001, a);
        g.gain.exponentialRampToValueAtTime(0.14, a + 0.01);
        g.gain.setValueAtTime(0.14, a + 0.11);
        g.gain.exponentialRampToValueAtTime(0.0001, a + 0.14);
        o.connect(g).connect(this.master);
        o.start(a); o.stop(a + 0.16);
      }
    }
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

  /* ---------------- movement (footsteps / roll / hover) ---------------- */

  /** A soft, padded footfall. `speed01` gives faster steps a touch more body. */
  footstep(speed01 = 0.5) {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    // Start the read at a random offset so successive steps aren't identical.
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320 + Math.random() * 120;
    const g = this.ctx.createGain();
    const peak = 0.05 + speed01 * 0.04;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.13);
    // A soft low thud gives the step weight.
    this._blip('sine', 120 + Math.random() * 30, 70, t, 0.09, 0.05 + speed01 * 0.03);
  }

  /**
   * Set the continuous movement bed: 'roll' (marble), 'hover' (feetless
   * heroes) or null (footstep walkers / nothing). Crossfades like vehicles.
   */
  setMoveBed(kind) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (this._move && this._move.kind === kind) return;
    this._stopMove();
    if (!kind) return;
    this._move = kind === 'roll' ? this._rollBed() : this._hoverBed();
    if (this._move) this._move.kind = kind;
  }

  /** Modulate the active move bed by speed (0..1). No-op if no bed. */
  setMoveIntensity(x) {
    if (!this._move) return;
    const t = this.ctx.currentTime;
    const v = Math.max(0.0001, Math.min(1, x));
    this._move.intensity.gain.setTargetAtTime(v, t, 0.08);
  }

  _stopMove() {
    const m = this._move;
    this._move = null;
    if (!m) return;
    const t = this.ctx.currentTime;
    m.gain.gain.cancelScheduledValues(t);
    m.gain.gain.setValueAtTime(m.gain.gain.value, t);
    m.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    for (const n of m.nodes) { try { n.stop(t + 0.25); } catch (e) { /* gains */ } }
  }

  /** Marble roll: a low granular rumble whose brightness rides with speed. */
  _rollBed() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 0.22;
    out.connect(this.master);
    const intensity = this.ctx.createGain(); // 0..1 speed modulation
    intensity.gain.value = 0.0001;
    intensity.connect(out);

    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 3;
    src.connect(lp).connect(intensity);
    // A low tone under it gives the marble mass on the boards.
    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 70;
    const tg = this.ctx.createGain();
    tg.gain.value = 0.4;
    tone.connect(tg).connect(intensity);

    src.start(t); tone.start(t);
    return { nodes: [src, tone], gain: out, intensity };
  }

  /** Feetless hover: an airy, ethereal whoosh that swells with movement. */
  _hoverBed() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 0.2;
    out.connect(this.master);
    const intensity = this.ctx.createGain();
    intensity.gain.value = 0.0001;
    intensity.connect(out);

    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    src.connect(bp).connect(intensity);
    // A soft sine glow gives the hover a warm, spectral undertone.
    const glow = this.ctx.createOscillator();
    glow.type = 'sine';
    glow.frequency.value = 138;
    const gg = this.ctx.createGain();
    gg.gain.value = 0.5;
    glow.connect(gg).connect(intensity);
    // Slow LFO wafts the airflow so it never sits still.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.6;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain).connect(bp.frequency);

    src.start(t); glow.start(t); lfo.start(t);
    return { nodes: [src, glow, lfo], gain: out, intensity };
  }

  /* ---------------- ambient music (looped placeholder) ---------------- */

  /**
   * A gentle, evolving ambient loop synthesised on the fly — a warm triad
   * pad drifting through a four-chord progression under a sparse pentatonic
   * arpeggio. Deliberately a PLACEHOLDER: swap in your own track later by
   * replacing this method. Uses a lookahead scheduler on the audio clock.
   */
  startMusic() {
    if (this._music || !this.ctx || this.ctx.state !== 'running') return;
    const bus = this.ctx.createGain();
    bus.gain.value = 0.11;
    bus.connect(this.master);
    const warmth = this.ctx.createBiquadFilter();
    warmth.type = 'lowpass';
    warmth.frequency.value = 1500;
    warmth.connect(bus);
    this._music = { bus, warmth };
    this._musicStep = 0;
    this._musicBeat = 0.5; // seconds per step
    this._musicNext = this.ctx.currentTime + 0.1;
    // vi–IV–I–V in A minor, each held for 8 steps (4 s). Roots + triads (Hz).
    this._musicChords = [
      [220.0, 261.6, 329.6], // Am
      [174.6, 220.0, 261.6], // F
      [261.6, 329.6, 392.0], // C
      [196.0, 246.9, 293.7]  // G
    ];
    // A minor pentatonic for the arpeggio (two octaves up-ish).
    this._musicScale = [440.0, 523.3, 587.3, 659.3, 784.0, 880.0];
    this._musicTick();
  }

  _musicTick() {
    if (!this._music) return;
    const lookahead = 0.25;
    while (this._musicNext < this.ctx.currentTime + lookahead) {
      this._musicNoteAt(this._musicNext, this._musicStep);
      this._musicNext += this._musicBeat;
      this._musicStep++;
    }
    this._musicTimer = setTimeout(() => this._musicTick(), 60);
  }

  _musicNoteAt(t, step) {
    const chord = this._musicChords[Math.floor(step / 8) % this._musicChords.length];
    const dest = this._music.warmth;
    // Pad: retrigger the sustained triad at the top of each chord.
    if (step % 8 === 0) {
      const hold = this._musicBeat * 8;
      for (const f of chord) {
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.09, t + 0.8);         // slow swell
        g.gain.setValueAtTime(0.09, t + hold - 1.0);
        g.gain.exponentialRampToValueAtTime(0.0001, t + hold); // fade out
        o.connect(g).connect(dest);
        o.start(t); o.stop(t + hold + 0.05);
      }
    }
    // Arpeggio: a soft pluck on some beats, resting on others for space.
    if (step % 2 === 0 || step % 8 === 3) {
      const f = this._musicScale[(step * 3) % this._musicScale.length];
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + 0.65);
    }
  }

  stopMusic() {
    if (this._musicTimer) { clearTimeout(this._musicTimer); this._musicTimer = 0; }
    if (this._music) {
      const t = this.ctx.currentTime;
      this._music.bus.gain.setTargetAtTime(0.0001, t, 0.3);
      this._music = null;
    }
  }

  /** Silence the transient beds (e.g. on game over); music keeps drifting. */
  stopAll() {
    this._stopVehicle();
    this._stopMove();
    this._pendingVehicle = null;
  }
}
