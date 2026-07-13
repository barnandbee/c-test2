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

## Sound

All sound is **synthesised at runtime** with the Web Audio API — there are
no audio files, so the game stays a zero-asset static site that works
offline.

- **Movement** — walkers get soft **footsteps** paced to their trot;
  Marblella has a low continuous **rolling** rumble; and the feetless
  heroes (the Haunted Sweatshirt, Perpendicular Bird, President Fir Tree,
  Rhombus the Hat) drift on an airy **hover** whoosh that swells with speed.
- **Feedback** — a springy **bounce** on jumps, a **sparkle** on pickups
  (grander for the golden ones), a **chime** for each trophy, a rising
  **slide-whistle** when a hero unlocks, and a soft **pip** each time you
  flip between character choices.
- **Hazards** — a croaky **ribbit** when a toxic frog gets you, and a
  cartoon **beep beep** when Magnus clips you with the golf cart.
- **Events** — a brassy **bugle** for the Magna Carta, **clock ticks** when
  time is banked, a **sonar ping** on striking the submarine, a wet
  **squelch** as Mayonnaise (or Jam) dresses the sandwich, a departing-**train**
  motif on the Mystic Line, and a **victory fanfare** for winning Veggie
  Tac Toe.
- **Vehicles** — each rides its own looping engine bed (hovercraft **whir**,
  balloon **burner hiss**, rocket **roar**) that fades in on boarding and
  out on dismount.
- **Ambient music** — a gentle, evolving **placeholder loop** (a warm triad
  pad drifting through a four-chord progression under a sparse arpeggio),
  synthesised in `startMusic()` and ready to be swapped for your own track.
  It plays **over the welcome menu too** (from your first click), not just
  in-game.

A **🔊 toggle** in the HUD mutes everything (remembered between runs).
Audio unlocks on your first click or key, per browser autoplay rules.

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
- **Error #42** — collect **one of every species in a single run** —
  a pine cone, a cherry, a cloud, a golden egg, a star and a Magna
  Carta — and the character loader gives out. The eleventh hero is an
  amalgamation of all the others: badger head, half-foil half-block
  torso with a neon corruption seam, one googly eye and one alien eye,
  one horn and one antenna, half a moustache, a misinstalled crown
  point, Edith's faucet out the back, mismatched limbs, and an
  intermittent positional glitch that is definitely a feature.
- **Mayonnaise** — finish a run with **300+ points** to unlock a jar of
  mayonnaise: cream contents, gold lid, wraparound label, quiet
  confidence.
- **The cave** — a short tunnel dug below grade under a low rock hood,
  its wide mouth facing the heart of the map. Walk down the bare-earth
  ramp: on a pedestal, under a mysterious glow, a **BLT**. Double-tap
  it and it says what everyone's thinking: *it's a BLT, but it's a bit
  too dry…* Unless you're Mayonnaise — then it's worth **+55.5 points**
  (once per run) and unlocks **Perpendicular Bird**: a pencil sketch of
  a bird, in profile, top hat, both wings locked perfectly horizontal,
  with a right-angle marker under the wing that literally says **90°**.
  Casts no shadow. Drawings don't.
- **The cottage** — a little plastered cottage on a leveled yard, door
  open, windows glowing. The roof lifts away dollhouse-style while
  you're inside. Double-tap the appliances: the **alarm clock** rings
  for **+20 seconds** (once per run — after that it's hoarse), the
  stove and fridge have opinions, and the **Persian rug** slides aside
  to reveal a **trap door** (see *Cottage Lane*, below). Touch all
  four fixtures in one run and **Marblella** rolls onto the roster: a
  glass marble with a cat's-eye twist, the only hero who can enter
  water — she's TOO DENSE to bounce off it (and too dense for the hot
  air balloon, which refuses her outright). She sinks straight to the
  lake bed and trundles along it, which means she can claim **Red
  October even while the boat lurks submerged**. While you're down
  there: a fan of coral glows on the lake bed, because someone should
  see it.
- **Cottage Lane** — the trap door's lock only respects a **perfectly
  square score** (1, 4, 9, 16, 25…). Arrive square, double-tap, and it
  swings open — down the stairs to a London Underground platform 14m
  below the cottage: tiled arch, red accent bands, a sunken track bed
  with rails and sleepers, the yellow line (mind the gap), a **COTTAGE
  LANE roundel**, humming strip lights, a bench, and a **ticket
  machine** that is out of order and only ever took exact change.
  A few **pine cones and golden eggs** wait down there — one on the
  tracks, for the brave. Once open, the door stays open for the rest
  of the run; the **WAY OUT** stairs take you back up to the rug.
- **The Mystic Line** — the ticket machine operates only during the
  **morning rush (06:00–09:00 on YOUR clock)** — or for a customer
  presenting **exactly 281 points**. Exact change only. When it hums
  into life it offers three destinations (tap, or press 1/2/3):
  **A) Upper Cottage Lane** — emerges at the cave mouth, where a
  roundel sign appears, **+55.5**; **B) Docklands** — the lake shore,
  new roundel, worth the same **+63.14159** as Red October herself;
  **C) Mystic Forest Central** — end of the line: a copse of leafy,
  twinkling trees on the floor of a hidden dell, **sealed under a
  stone dome** — the ring wall is a slide, the sky is closed, and no
  balloon, rocket or hovercraft may descend into it. Only the ticket
  gets you in. Inside, **all color drains away**: the grove and your
  hero alike render in near-grayscale until you leave. **Jump three
  times in the Mystic Forest** and the grove holds an election: 
  **President Fir Tree** joins the roster — three tiers of stately
  conifer, googly statesman's eyes, branch arms for waving at
  constituents, a red tie with a gold seal pin and a star of office
  on his crown. The MYSTIC FOREST CENTRAL roundel by the trees is the
  ride home. Fares pay out once per run each; the trains themselves
  are, naturally, invisible.
- **Margaret** — a classic wooden marionette with a painted face,
  buttons for eyes, string hair and the four control strings rising to
  an unseen crossbar. A demanding performance unlocks her: in a single
  run, collect **5 atomic cherries**, **4 marshmallow clouds**, take
  **5 frog hits**, and finish on a score whose **last digit is 4**
  (14, 84, 134…). Curtain up.
- **Julie** — a fluffy blue-merle doodle: a curly grey-and-white
  marbled coat with dark patches, one black floppy ear, a black
  eye-mask over one bright-blue eye, a shaggy grey-white beard, a black
  button nose and a gold flower-shaped tag on her collar. Unlock her by
  **dismounting from all three of the rocket, the hovercraft and the
  balloon in a single run**. Good girl.
- **Turnip Scart** — a shaggy goat who ambles around a little fenced
  **vegetable patch** — dark tilled soil rows of cabbages, carrots and
  purple-topped turnips — stopping to graze, somewhere out on the map.
  Stand on his patch with a score that's a **multiple of 7** and
  double-tap to challenge him to **Veggie Tac Toe**: tic-tac-toe from a
  bird's-eye view, you planting 🥬 cabbages against his 🟣 turnips (tap
  a square or press 1–9; the run clock freezes). The panel drops to the
  bottom, clear of the board, and minimises if it's in the way. You get
  **one game per run**. **Beat the goat** and he joins the roster as a
  playable character.
- **Haunted Sweatshirt** — an ethereal, faceless blue garment that
  floats where a body should be: a translucent glowing torso with a
  ribbed hem and collar, an empty neck void lit by a cold inner glow,
  and two limp sleeves that sway as it drifts. No legs, no face — it
  simply hovers. Unlock it once you've **amassed 30 achievements in
  total** — trophies earned plus characters unlocked.
- **Jam** — Mayonnaise's funkier cousin: a glass jar of deep berry
  preserve under a red gingham cloth cap tied with string. Like Mayo, she
  can dress the cave BLT for the same **+55.5** — "it's funky, but it
  works!" Unlock her by scoring an **all-time total of 1000 points**
  across every run you've ever played.
- **Dodecahedron the Beret** — a twelve-faced teal solid wearing a jaunty
  navy beret at a rakish tilt, little nub and all. A geometric cousin to
  Rhombus the Hat; feetless, so it drifts. Unlock it by finishing a run
  with **300+ points while playing as Rhombus the Hat**.
- **Polar Pear** — a bulky white polar bear whose head is a ripe green
  pear (stalk, leaf and little snow-white ears included). Unlock it by
  reaching the **mountain summit flag on just 10 health** and then
  **surviving the rest of the run** to the bell.
- **Night Eye** — a futuristic special-ops soldier in matte charcoal
  armour, with a visored helmet, an antenna and two glowing **laser eyes**
  that fire thin red beams. Unlock it by scoring an **all-time total of
  10000 points** across every run.
- **Pineapple Penguin** — an upright penguin (black back, white belly,
  orange feet and flippers) whose head is a whole **pineapple**:
  crosshatched golden skin, a spiky green crown and a little beak. Unlock
  it by reaching the **mountain summit flag with a score over 333**.
- **Billy Rocketfingers** — a cool astronaut in a white spacesuit under a
  black **rockstar leather jacket** (raised collar, open lapels over a red
  tee), a bubble helmet with a gold visor and a pair of **shades** pushed
  over the front, plus a life-support pack. His rocket-boosted boots give
  him a **much higher, floatier jump** — high enough to bound up and pluck
  the cherries off the treetops. Unlock it by **collecting every star AND
  riding to all three Mystic Line stations in one run**.
- **Pickle Stick** — a warty green gherkin with a big pair of googly eyes
  that **hops** to get around. To unlock it: poke the cottage **fridge 10
  times** (the message turns to “Oh, Pickle Sticks!”), at which point a
  Pickle Stick perches on top of a random tree — go **collect it like an
  item (+8.88) with a score of 100 or more**. Afterwards the Pickle Stick
  item can still turn up in the wild worth +8.88, though there's little
  point.
- **Glass Badger** — the badger cast in translucent frosted glass: you can
  see clean through it to a glowing core, with a frosted muzzle, the two
  smoky face-stripes and glassy limbs. Unlock it by scoring an **all-time
  total of 20000 points** across every run.
- **McDonovan** — a film-noir private eye who happens to be a mouse: big
  round ears, whiskers and a pink rope tail under a muted trench coat
  (raised collar, belt) and a grey **fedora** tilted low. Unlock him by
  **riding the Mystic Line all the way to Docklands** — a private eye's
  kind of town.
- **The Platinum Guava (+50)** — once per run, at a random moment inside
  the **final 30 seconds**, a platinum guava plummets from the sky and
  lands on a random patch of grass, ringed by a spinning **prism halo** and
  a shower of sparkles. Worth a hefty **50** — if you can reach it before
  the bell (no guarantee it lands anywhere near you).
- **The snow-capped mountain** — out in the far south-east corner,
  diagonally opposite the lake and the sealed Mystic Forest and well clear
  of the pink blossom tree and every other landmark, rises a proper peak: a
  clean, evenly-graded cone about 18 units tall, green at the foot,
  banding through bare rock into a bright **snow cap**. Its slopes are
  deliberately tuned to stay **climbable** (never a slide), and a little
  **cairn with a fluttering blue pennant** crowns the summit to reward the
  climb. Built straight into the height field, so collision, the surface
  tint and the snowline can never disagree.
- **The golf hole** — a mown-stripe putting green with a red flag and a
  sand bunker, tucked on a hillside. Mostly decorative — unless Magnus
  has already run you over. Get **hit by the golf cart**, then drive
  the **hovercraft onto the green** (as anyone *except* Magnus Carter),
  and a challenge is issued: double-tap to play **Puttmost Respect**, a
  putting minigame. The run clock **freezes** while you putt. A **club
  and a bright aim arrow** show exactly where the ball will go; swing
  the camera (A/D or drag) to aim, hold jump to charge the power meter
  (the arrow grows and the club takes a backswing), release to putt.
  The ball breaks with the slope and the rough is heavy. Three
  strokes: sink it for **+18**, hole it in one for **+33**, miss out
  entirely and receive only wisdom. Once per run; double-tap mid-game
  to concede.
- **The welcome menu** — an epic title screen with the twilight forest
  drifting behind it: your best score, the full hero roster, and one
  large inviting button. The clock doesn't start until you press it.
- **Achievements** — the game-over screen (which now scrolls, so the
  full roster and buttons are always reachable) carries an
  **Achievements** button. It opens a viewer listing every hero and every
  trophy — but anything you **haven't unlocked yet keeps its how-to
  hidden** (shown as `???`), so nothing spoils the way to earn it; the
  description is revealed only once you've earned it. It lists score
  milestones (50 / 100 / 200 / 300 / 400 / 500), a decimal score,
  three and ten clock-tower visits in a run, a Puttmost hole-in-one,
  reaching the tube station, riding the Mystic Line, diving to the lake
  bed as Marblella, collecting a star or a cloud, clearing every star /
  cloud / cherry / golden pine cone in a run (and all three of stars,
  cherries and clouds together), letting your health hit zero, the
  **Yo-Yo 🪀** (bouncing your score across 100 up-down-up-down-up in one
  run), and unlocking 1 / 5 / 10 characters. It also tracks the long-haul
  feats: scoring 100 with 10 / 200 with 20 / 300 with 30 different
  characters (**C Unit** / **C Change** / **C U Later**), playing as
  5 / 10 / 20 different heroes,
  visiting all three Mystic Line stations in one run, taking President Fir
  Tree home to the Mystic Forest, taking Polar Pear to the summit flag,
  beating Turnip Scart at Veggie Tac Toe *while playing as Turnip Scart*,
  and **Snooker 🎱** — landing on exactly 147 in a run having collected one
  of every item type. Earned trophies are saved locally
  and announced with a 🏆 toast the moment you earn them. Two lifetime stats
  sit up top: your **all-time points** (summed across every run) and your
  **favourite hero** (the character you've played the most, with its run
  count).

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
  PuttingGame.js    'Puttmost Respect' putting minigame (ball physics,
                    power meter, slope break, club + aim arrow)
  VeggieTacToe.js   'Veggie Tac Toe' — tic-tac-toe vs Turnip Scart
  Particles.js      GPU burst pool, gold aura, poison cloud point systems
  Shaders.js        toon/rim/sway/pulse material patches, exponential
                    height fog, sky gradient, all particle GLSL
  Input.js          keyboard/mouse with pointer lock + jump buffering
  Achievements.js   trophy + character-unlock definitions for the viewer
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
