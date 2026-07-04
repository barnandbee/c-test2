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
  the headlights.
- **The Escher stairs** — a floating stone folly of switchback flights
  (with a mirrored flight hanging impossibly underneath) on the east
  side of the map. Hop all the way up for the summit Magna Carta, then
  leap off the top like you mean it.

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
