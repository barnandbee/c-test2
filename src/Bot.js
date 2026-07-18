/**
 * Bot.js — the CPU rival for versus mode: a second Player driven by a
 * synthetic input object instead of the keyboard. The brain is a greedy
 * collector: every re-think it scores each idle, ground-reachable
 * collectible by value-per-distance, beelines for the best one, hops when
 * its target sits above it, and jiggles sideways when it gets stuck on
 * scenery. A progress watchdog blacklists any target it can't actually
 * close in on, so it never grinds against a wall forever.
 *
 * Two difficulties:
 *  - 'easy' (Simple Seeds): the mild forager.
 *  - 'hard' (Nefarious Nuts): thinks faster, prizes value more, hustles a
 *    little quicker, and rides the Mystic Line between the three surface
 *    stops when the good stuff is far away.
 */

const PROFILES = {
  easy: {
    rethink: 0.4,       // seconds between target re-evaluations
    reachable: 3.0,     // max item height above terrain worth chasing
    valuePower: 1.0,    // >1 weights big prizes harder
    distPad: 6,         // metres added to distance when scoring
    moveScale: 1.0,     // engine speed multiplier
    ridesLine: false
  },
  hard: {
    rethink: 0.22,
    reachable: 3.5,
    valuePower: 1.25,
    distPad: 3,
    moveScale: 1.12,
    ridesLine: true
  }
};

const STUCK_SPEED = 0.6;     // below this while wanting to move = maybe stuck
const STUCK_TIME = 0.7;      // seconds of stall before the unstick kicks in
const UNSTICK_TIME = 0.55;   // seconds of sideways escape steering
const NO_PROGRESS_TIME = 2.5; // seconds without closing in → give up on target
const BLACKLIST_TIME = 8;    // seconds a given-up target stays off the menu
const RIDE_MIN_DIST = 45;    // only consider the train for hauls this long
const RIDE_COOLDOWN = 12;    // seconds between rides
const RIDE_BOARD_RANGE = 2.5; // how close to the stop counts as boarding

export class CpuRival {
  /**
   * @param {import('./Game.js').Game} game the running game (world + items)
   * @param {import('./Player.js').Player} player the rival's own Player
   * @param {'easy'|'hard'} difficulty brain profile
   */
  constructor(game, player, difficulty = 'easy') {
    this.game = game;
    this.player = player;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty] || PROFILES.easy;
    this.player.moveScale = this.profile.moveScale;
    this.points = 0;

    this.time = 0;
    this.target = null;
    this.rethinkTimer = 0;
    this.stuckTimer = 0;
    this.unstickTimer = 0;
    this.unstickSign = 1;

    // Progress watchdog: closest approach so far, and how long since it
    // last improved. Targets that never get closer get blacklisted.
    this.bestDist = Infinity;
    this.noProgressTimer = 0;
    this.blacklist = new Map(); // item -> time the grudge expires

    // Mystic Line state (hard only): the stop being walked to, and where
    // the ride comes out.
    this.ridePlan = null; // { from: {x,z}, to: {x,z}, expires }
    this.rideCooldown = 0;

    // The four fields Player.update actually reads, plus the jump queue.
    this._jumpQueued = false;
    const self = this;
    this.input = {
      axisX: 0,
      axisY: 0,
      jumpHeld: false,
      consumeJump() {
        const j = self._jumpQueued;
        self._jumpQueued = false;
        return j;
      }
    };
  }

  update(dt) {
    this.time += dt;
    this.rideCooldown = Math.max(0, this.rideCooldown - dt);
    this.think(dt);
    // cameraYaw 0 makes the axes world-space: +axisX = +x, +axisY = -z.
    this.player.update(dt, this.input, 0);
  }

  think(dt) {
    const pos = this.player.position;

    // --- keep or re-pick the target ---------------------------------------
    this.rethinkTimer -= dt;
    const lostTarget = !this.target || this.target.state !== 'idle';
    if (lostTarget || this.rethinkTimer <= 0) {
      const fresh = this.pickTarget();
      if (fresh !== this.target) {
        this.target = fresh;
        this.bestDist = Infinity;
        this.noProgressTimer = 0;
        this.ridePlan = null;
      }
      this.rethinkTimer = this.profile.rethink;
    }

    if (!this.target) {
      this.input.axisX = 0;
      this.input.axisY = 0;
      this.input.jumpHeld = false;
      return;
    }

    const tp = this.target.group.position;
    const targetDist = Math.hypot(tp.x - pos.x, tp.z - pos.z);

    // --- progress watchdog -------------------------------------------------
    // "Closing in" means beating our best approach so far. A bot pinned
    // against the cottage wall never does, and gives the target up.
    if (targetDist < this.bestDist - 0.4) {
      this.bestDist = targetDist;
      this.noProgressTimer = 0;
    } else {
      this.noProgressTimer += dt;
      if (this.noProgressTimer > NO_PROGRESS_TIME) {
        this.blacklist.set(this.target, this.time + BLACKLIST_TIME);
        this.target = null;
        this.ridePlan = null;
        this._jumpQueued = true; // hop free while the next pick comes in
        this.unstickSign = Math.random() < 0.5 ? -1 : 1;
        this.unstickTimer = UNSTICK_TIME;
        return;
      }
    }

    // --- the Mystic Line (Nefarious Nuts only) -----------------------------
    if (this.profile.ridesLine) this.considerRide(targetDist);

    // Steer toward the boarding stop while a ride is planned; otherwise
    // toward the prize itself.
    let gx = tp.x;
    let gz = tp.z;
    if (this.ridePlan) {
      if (this.time > this.ridePlan.expires) {
        this.ridePlan = null; // took too long — walk it off
      } else {
        gx = this.ridePlan.from.x;
        gz = this.ridePlan.from.z;
        const board = Math.hypot(gx - pos.x, gz - pos.z);
        if (board < RIDE_BOARD_RANGE) {
          this.boardLine();
          return;
        }
      }
    }

    let dx = gx - pos.x;
    let dz = gz - pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist;
    dz /= dist;

    // --- stuck? hop and sidestep ------------------------------------------
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    if (dist > 2 && speed < STUCK_SPEED) {
      this.stuckTimer += dt;
      if (this.stuckTimer > STUCK_TIME) {
        this._jumpQueued = true;
        this.unstickSign = Math.random() < 0.5 ? -1 : 1;
        this.unstickTimer = UNSTICK_TIME;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
    if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      // Steer perpendicular to the blocked line of approach.
      const px = -dz * this.unstickSign;
      const pz = dx * this.unstickSign;
      dx = px;
      dz = pz;
    }

    this.input.axisX = dx;
    this.input.axisY = -dz;

    // --- jumping ----------------------------------------------------------
    // Hop when the prize sits above us and we're closing in.
    if (
      this.player.grounded &&
      dist < 5 &&
      tp.y > pos.y + 1.0
    ) {
      this._jumpQueued = true;
    }
    // Hold through the rise for full-height jumps.
    this.input.jumpHeld = this._jumpQueued || this.player.velocity.y > 1;
  }

  /**
   * Weigh up a train ride: worth it when the prize is a long haul away
   * and hopping between line stops cuts the walk meaningfully.
   */
  considerRide(targetDist) {
    if (this.ridePlan || this.rideCooldown > 0) return;
    if (targetDist < RIDE_MIN_DIST) return;
    const stops = this.game.getLineStops();
    if (!stops || stops.length < 2) return;
    const pos = this.player.position;
    const tp = this.target.group.position;

    let from = null;
    let fromDist = Infinity;
    let to = null;
    let toDist = Infinity;
    for (const s of stops) {
      const dMe = Math.hypot(s.x - pos.x, s.z - pos.z);
      const dTarget = Math.hypot(s.x - tp.x, s.z - tp.z);
      if (dMe < fromDist) { fromDist = dMe; from = s; }
      if (dTarget < toDist) { toDist = dTarget; to = s; }
    }
    if (!from || !to || from === to) return;
    // Ride only when walking to the stop + walking from the far stop
    // clearly beats the straight slog.
    if (fromDist + toDist + 8 < targetDist) {
      this.ridePlan = { from, to, expires: this.time + 15 };
    }
  }

  /** The rival taps in: teleport stop-to-stop with the full ceremony. */
  boardLine() {
    const to = this.ridePlan.to;
    this.ridePlan = null;
    this.rideCooldown = RIDE_COOLDOWN;
    const g = this.game;
    const pl = this.player;
    g.particles.spawnBurst(pl.position, 0x9ec2ff, {
      count: 24, speed: 4.5, size: 40, upBias: 0.7, life: 0.6
    });
    pl.position.set(to.x, g.world.getHeight(to.x, to.z) + 0.15, to.z);
    pl.velocity.set(0, 0, 0);
    this.bestDist = Infinity;
    this.noProgressTimer = 0;
    g.particles.spawnBurst(pl.position, 0x9ec2ff, {
      count: 30, speed: 5, size: 44, upBias: 0.75, life: 0.7
    });
    g.audio.play('train');
    g.ui.showTimeToast('🤖 THE RIVAL RIDES THE MYSTIC LINE');
  }

  /**
   * Greedy pick: value per metre, among idle items the bot can plausibly
   * reach on foot (treetop cherries and sky stars are for the humans).
   * Recently hopeless targets sit on the blacklist and are skipped.
   */
  pickTarget() {
    const pos = this.player.position;
    const world = this.game.world;
    const prof = this.profile;
    let best = null;
    let bestScore = -Infinity;
    for (const item of this.game.collectibles) {
      if (item.state !== 'idle') continue;
      const grudge = this.blacklist.get(item);
      if (grudge !== undefined) {
        if (this.time < grudge) continue;
        this.blacklist.delete(item);
      }
      const p = item.group.position;
      if (p.y - world.getHeight(p.x, p.z) > prof.reachable) continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      const score = Math.pow(item.value, prof.valuePower) / (d + prof.distPad);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }
}
