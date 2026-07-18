/**
 * Bot.js — the CPU rival for versus mode: a second Player driven by a
 * synthetic input object instead of the keyboard. The brain is a greedy
 * collector: every re-think it scores each idle, ground-reachable
 * collectible by value-per-distance, beelines for the best one, hops when
 * its target sits above it, and jiggles sideways when it gets stuck on
 * scenery. The physics engine can't tell it apart from a human.
 */

const RETHINK_INTERVAL = 0.4;  // seconds between target re-evaluations
const REACHABLE_HEIGHT = 3.0;  // max item height above terrain the bot will chase
const STUCK_SPEED = 0.6;       // below this while wanting to move = maybe stuck
const STUCK_TIME = 0.7;        // seconds of stall before the unstick kicks in
const UNSTICK_TIME = 0.55;     // seconds of sideways escape steering

export class CpuRival {
  /**
   * @param {import('./Game.js').Game} game the running game (world + items)
   * @param {import('./Player.js').Player} player the rival's own Player
   */
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.points = 0;

    this.target = null;
    this.rethinkTimer = 0;
    this.stuckTimer = 0;
    this.unstickTimer = 0;
    this.unstickSign = 1;

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
    this.think(dt);
    // cameraYaw 0 makes the axes world-space: +axisX = +x, +axisY = -z.
    this.player.update(dt, this.input, 0);
  }

  think(dt) {
    const pos = this.player.position;

    // --- keep or re-pick the target ---------------------------------------
    this.rethinkTimer -= dt;
    if (
      !this.target ||
      this.target.state !== 'idle' ||
      this.rethinkTimer <= 0
    ) {
      this.target = this.pickTarget();
      this.rethinkTimer = RETHINK_INTERVAL;
    }

    if (!this.target) {
      this.input.axisX = 0;
      this.input.axisY = 0;
      this.input.jumpHeld = false;
      return;
    }

    const tp = this.target.group.position;
    let dx = tp.x - pos.x;
    let dz = tp.z - pos.z;
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
   * Greedy pick: value per metre, among idle items the bot can plausibly
   * reach on foot (treetop cherries and sky stars are for the humans).
   */
  pickTarget() {
    const pos = this.player.position;
    const world = this.game.world;
    let best = null;
    let bestScore = -Infinity;
    for (const item of this.game.collectibles) {
      if (item.state !== 'idle') continue;
      const p = item.group.position;
      if (p.y - world.getHeight(p.x, p.z) > REACHABLE_HEIGHT) continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      const score = item.value / (d + 6);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }
}
