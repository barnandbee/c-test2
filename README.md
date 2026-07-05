# Badger of the Mystic Forest

A high-fidelity 3D third-person platformer prototype in the spirit of
Spyro / Banjo-Kazooie, built with Three.js, custom GLSL and zero build step.

## Running

Any static file server works (ES modules require `http://`, not `file://`):

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>.

Three.js r160 is vendored at `vendor/three.module.js` and wired through an
import map — no npm install, no bundler.

## Controls

| Input  | Action                                  |
| ------ | --------------------------------------- |
| WASD / arrows | Move (camera-relative)           |
| Space  | Jump (buffered, coyote time, variable height) |
| Mouse  | Orbit camera (click to pointer-lock)    |
| Scroll | Zoom the spring arm                     |

## Gameplay

- **The clock** — you have **3 minutes**. When it runs dry, the run ends.
  Your best score is kept locally between sessions.
- **Pine cones (+1)** — hovering, spinning, with an emissive glow pulse.
- **Golden eggs (+10)** — rare gold-PBR collectibles ringed by an orbiting
  particle aura; they live out toward the wild edges of the map.
- **Toxic frogs** — hopping hazards wrapped in a translucent poison cloud,
  croaking through an inflating throat sac. Entering the cloud costs 10
  health, flashes the screen and knocks the badger back. Health starts at
  100; at 0 the twilight claims you.
- **The clock tower** — a glowing landmark whose minute hand literally
  shows your time remaining. Touch it for **+10 seconds** — but it
  teleports across the map afterward, so every visit is a detour that
  trades points for time.
- **Badgerette** — finish a run with a score **over 30** to unlock a
  second hero: flowing ginger hair, golden tiara, same dig-happy claws.
  Pick your hero on the game-over screen; the choice persists.
- **'Crisp Packet' Hughes** — survive the **full three minutes without
  taking a single hit** (health still 100 when the bell tolls) to unlock
  the third hero: an anthropomorphic foil crisp packet with stick arms
  and legs, jaunty red shoes and googly eyes that rattle when he runs,
  jumps or lands. His arms flail skyward mid-jump, as they should.
- **Mr Finn Boffington** — bank **60 bonus seconds in a single run**
  (six clock-tower visits) to unlock the fourth hero: a dapper blue
  block-fellow with curved horns, a purple waistcoat and a bow tie.
- **The Magna Carta (+25)** — very rare parchment wreathed in silver
  sparkles. One crowns the Escher stairs; one hides in the far wilds.
- **Magnus Carter** — a small elf tearing around the forest in a golf
  cart. Getting run over costs **20 health and 20 points**. Listen for
  the headlights. Take **four hits**, survive the **full three minutes
  anyway**, and still finish with **50+ points**, and Magnus himself
  joins the roster — green tunic, red cap, zero remorse. And should
  Magnus himself be run over by his own cart **twice in one run**, the
  paradox summons **Mr Flynn Boddington** — Finn Boffington's orange
  nemesis twin, horned as ever, now with slanted brows and a handlebar
  moustache of unmistakable intent.
- **The Escher stairs** — a floating stone folly of switchback flights
  (with a mirrored flight hanging impossibly underneath) on the east
  side of the map. Hop all the way up for the summit Magna Carta, then
  leap off the top like you mean it.
- **The lake & Red October** — a carved lake on the west side, with a
  shore sign that says exactly what it should. A dark-red submarine
  periodically breaches, bobs, and slips back under. Reaching her while
  surfaced is worth **+63.14159 points** (once per run). Nobody in this
  forest can swim — wade too deep and you're bounced back to shore.
- **The hovercraft** — parked somewhere random on dry land, marked by a
  pulsing blue beacon. Stand next to it and **double-tap / double-click**
  to hop in; it skims over land and water alike (it's the only way to
  reach Red October). Double-tap again over solid ground to hop out —
  it won't let you strand it mid-lake.
- **The hot air balloon** — drifts in the moment your score reaches
  **100**. Board it like the hovercraft; the **jump button is the
  burner** (hold to rise, release to sink). Take it up during a run and
  the bell unlocks **Edith McCombe** — a kitchen sink on bird legs,
  with googly eyes, a gooseneck faucet and hot & cold taps.
- **Marshmallow clouds (+5)** — puffy pink-and-white clouds drifting
  ~20–28m above the forest, far higher than any tree or staircase.
  Collect them like pine cones — but only the balloon flies that high,
  which makes every flight a harvest run.
- **Atomic glacé cherries (+3)** — glowing candy-red cherries ringed by
  orbiting green electrons, perched on the crowns of ten random trees
  (7–12m up). Balloon work, mostly — though a bold leap from the Escher
  stairs or a cliff onto a neighboring canopy can pick off the low ones.
- **The space program** — one grand **cherry blossom tree** stands
  somewhere in the forest — twice the height of its neighbors, with a
  luminous pink canopy, an orbiting halo of petal sparkles and its own
  rose glow, so it reads from across the map. Double-tap beside it and a hidden
  **launchpad** grinds up out of the turf. A **rocket** lands on the pad
  only while your score sits **strictly between 88 and 112** — and it
  departs without you the moment your score leaves the window. Board it
  with a **triple-tap** — and triple-tap to climb out, too; rockets
  reward deliberation (jump = main engine) and blast far above the clouds, where nine golden
  **stars (+20)** hang in the void at 80–110m. Collect **five stars in
  one run** to unlock **Alien Ginsberg**: a small green poet with a
  beret, round spectacles, glowing antennae and a notebook he refuses
  to put down.
- **YOU GOT THE MAGNA CARTA, BABY!** — that's what it says, and
  grabbing one also unlocks **William the Conqueror**: the badger in a
  golden crown with a royal red cape that streams behind him at speed.
- **Rhombus the Hat** — finish with a score of **exactly 90, 180, 270
  or 360** (any right angle will do) to unlock the seventh hero: a
  resolutely 2D pink rhombus in a top hat, who waddle-rocks along his
  bottom vertex and pinwheels in mid-air. Pine cones are worth +1;
  do the arithmetic.
- **The welcome menu** — an epic title screen with the twilight forest
  drifting behind it: your best score, the full hero roster, and one
  large inviting button. The clock doesn't start until you press it.

## Architecture

```
index.html          import map + HUD overlay markup
styles.css          HUD, damage vignette, game-over card
src/
  main.js           entry point
  Game.js           renderer, loop, gameplay rules, lifecycle/teardown
  World.js          analytic simplex terrain, instanced forest, sky, lights,
                    texel-snapped follow shadow, PMREM environment
  Player.js         compound cel-shaded badger mesh (vertex-painted face
                    mask) + kinematic character controller
  CameraRig.js      collision-aware, damped third-person spring arm
  Entities.js       pine cones, golden eggs, toxic frogs (shared assets)
  Particles.js      GPU burst pool, gold aura, poison cloud point systems
  Shaders.js        toon/rim/sway/pulse material patches, exponential
                    height fog, sky gradient, all particle GLSL
  Input.js          keyboard/mouse with pointer lock + jump buffering
  UI.js             DOM HUD bindings
  utils/            seeded simplex noise, math helpers
vendor/
  three.module.js   Three.js r160 (vendored)
```

### Rendering notes

- Lit surfaces are `MeshToonMaterial` (3-tone gradient map) surgically
  patched via `onBeforeCompile` with `#ifdef`-gated chunks: crisp fresnel
  **rim light**, **wind sway** vertex animation, **emissive pulse** — so
  shadow mapping, instancing and vertex colors keep working untouched.
- Every patched material swaps stock fog for **exponential height fog**:
  valleys drown in twilight haze, hilltops stay clear.
- Foliage, rocks and grass are `InstancedMesh` (4 draw calls for the whole
  forest); all particle motion is integrated in vertex shaders.
- The directional shadow map (2048²) follows the player, snapped to the
  shadow-texel grid in light space to eliminate edge shimmer.
- Terrain collision samples the same analytic noise stack that displaced
  the mesh, so physics and visuals can never disagree.
- Pickups scale-down, burst and are disposed (`geometry.dispose()` /
  `material.dispose()`); bursts come from a fixed GPU pool.

### Character controller

Gravity, ground acceleration/friction, air momentum conservation with
limited steering, coyote time, jump buffering, short-hop gravity, slope
sliding above the steepness limit, downhill ground snapping (no landing
jitter) and cylinder push-out against trunks and rocks.
