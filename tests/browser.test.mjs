/**
 * Browser tests — the rules that can only be checked with the game running.
 *
 *   tests/run.sh            (starts a server and runs everything)
 *   node tests/browser.test.mjs http://127.0.0.1:8123/index.html
 *
 * Needs Playwright. Set PLAYWRIGHT_PATH if it is not on the default path.
 *
 * Everything runs in one browser launch: world generation is the slow part,
 * and it only has to happen once.
 */
const URL_ARG = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const PW = process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright/index.js';

let pw;
try {
  pw = (await import(PW)).default;
} catch {
  console.log(`‼️  browser: Playwright not found at ${PW}. Set PLAYWRIGHT_PATH. Skipping.`);
  process.exit(0);
}
const { chromium } = pw;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// Every hero who is, in the end, a badger. Electro Badger is earned by one of
// them, so getting this set wrong makes him unearnable for whoever is missing
// — which is exactly what happened to William the Conqueror once.
const EXPECTED_BADGERS = new Set([
  'badger', 'badgerette', 'william', 'glassbadger', 'vapour', 'spirit', 'electro',
  'phantom'
]);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  // No outbound network in CI containers, so the Google Fonts <link> fails.
  // That is the sandbox, not the game.
  if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|fonts\.g/.test(m.text())) {
    errs.push(m.text());
  }
});

const ready = (p = page) =>
  p.waitForFunction(() => window.__game && window.__game.world && window.__game.world.towerPos,
                    null, { timeout: 60000 });

await page.goto(URL_ARG);
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

/* == 1. who counts as a badger ========================================== */
console.log('\nisBadger across the roster');
const roster = await page.evaluate(async () => {
  const g = window.__game;
  const mod = await import('./src/Achievements.js');
  const keys = (mod.CHARACTER_UNLOCKS || mod.default.CHARACTER_UNLOCKS).map((c) => c.key);
  return keys.map((k) => { g.setCharacter(k); return { key: k, isBadger: !!g.player.isBadger }; });
});
const badgers = roster.filter((r) => r.isBadger).map((r) => r.key);
ok(`every hero builds (${roster.length} on the roster)`, roster.length > 40, String(roster.length));
ok(`exactly the badgers are badgers`,
   badgers.length === EXPECTED_BADGERS.size && badgers.every((b) => EXPECTED_BADGERS.has(b)),
   `got: ${badgers.join(', ')}`);

/* == 2. the transmission tower ========================================== */
console.log('\nTransmission tower');

/** Start a fresh run as `character` and touch the pylon `touches` times. */
const tower = (opts) => page.evaluate((o) => {
  const g = window.__game;
  // beginRun() only works from the menu (it returns early otherwise); every
  // later run arrives via restart(), which re-reads the game-over character
  // selection — so the hero is pinned again after either path.
  if (g.inMenu) { g.setCharacter(o.character); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(o.character);
  g.weather.set(o.weather);
  g.points = o.points;
  g.health = o.health;
  const w = g.world;
  const at = { x: w.towerX, y: w.towerLevel, z: w.towerZ };
  const hits = [];
  for (let i = 0; i < (o.touches || 1); i++) {
    g.invulnTimer = 0;          // the hazard cooldown, cleared so these tests
    hits.push(g.handleTower(at)); // measure the tower's own rules alone
  }
  return {
    hits, points: g.points, health: g.health,
    zapped: g.achievements.has('zapped'),
    antizapped: g.achievements.has('antizapped'),
    electro: g.electroUnlocked, allowed: g.isCharacterAllowed('electro')
  };
}, opts);

const clearElectro = () => page.evaluate(() => {
  localStorage.removeItem('mystic-badger.electroUnlocked');
  window.__game.electroUnlocked = false;
});

// -- the +40, and its once-per-run limit
for (const c of ['error42', 'error43', 'error44', 'sweatshirt']) {
  const r = await tower({ character: c, weather: 'storm', points: 0, health: 100, touches: 5 });
  ok(`${c}: five touches pay 40 once`, r.points === 40, `got ${r.points}`);
  ok(`${c}: still immune on every touch`, r.hits.every(Boolean) && r.health === 100,
     JSON.stringify({ hits: r.hits, health: r.health }));
  ok(`${c}: earns Anti-Zapped`, r.antizapped === true);
}
{
  const r = await tower({ character: 'error42', weather: 'storm', points: 0, health: 100, touches: 2 });
  ok('a new run recharges the pylon (and still pays once)', r.points === 40, `got ${r.points}`);
}

// -- damage, and Electro Badger
{
  const r = await tower({ character: 'badger', weather: 'storm', points: 0, health: 100, touches: 2 });
  ok('a non-conductor is shocked every time', r.health === 20 && r.points === 0, JSON.stringify(r));
}
{
  const r = await tower({ character: 'badger', weather: 'clear', points: 420, health: 100 });
  ok('the pylon is inert outside a storm', r.hits[0] === false && r.health === 100 && !r.zapped);
}

console.log('\nElectro Badger');
for (const [name, opts, want] of [
  ['badger at 420, zapped to zero → unlock', { character: 'badger', points: 420, health: 40 }, true],
  ['badgerette at 420 → unlock', { character: 'badgerette', points: 420, health: 40 }, true],
  ['william at 408 → unlock', { character: 'william', points: 408, health: 40 }, true],
  ['glassbadger at exactly 400 → unlock', { character: 'glassbadger', points: 400, health: 40 }, true],
  ['spirit at 500 → unlock', { character: 'spirit', points: 500, health: 40 }, true],
  ['badger at 399 → no unlock', { character: 'badger', points: 399, health: 40 }, false],
  ['tudor (not a badger) at 420 → no unlock', { character: 'tudor', points: 420, health: 40 }, false],
  ['nighteye (not a badger) at 420 → no unlock', { character: 'nighteye', points: 420, health: 40 }, false]
]) {
  await clearElectro();
  const r = await tower({ ...opts, weather: 'storm', touches: 1 });
  // `zapped` is a lifetime trophy: once earned it stays earned, so it says
  // nothing about this run. The per-run facts are the health and the unlock.
  ok(name, r.electro === want && r.health <= 0,
     JSON.stringify({ electro: r.electro, hp: r.health }));
}
{
  await clearElectro();
  const r = await tower({ character: 'badger', weather: 'storm', points: 420, health: 100, touches: 1 });
  ok('surviving the shock unlocks nothing', r.electro === false && r.health === 60, JSON.stringify(r));
}

/* == 3. the newest three ================================================= */
console.log('\nFoil, Error #44 and Ol\' Cardboard Box');

// Helpers installed in the page: start a run, and tap somewhere through the
// real handleDoubleTap() path rather than poking internals.
await page.evaluate(() => {
  window.__freshRun = (c) => {
    const g = window.__game;
    if (g.inMenu) { g.setCharacter(c); g.beginRun(false, 'easy'); }
    else { g.restart(false, 'easy'); }
    g.setCharacter(c);
  };
  window.__tapAt = (p, kind) => {
    const g = window.__game;
    g.player.position.set(p.x, p.y, p.z);
    g.input.consumeTripleTap = () => kind === 'triple';
    g.input.consumeDoubleTap = () => kind === 'double';
    g.handleDoubleTap();
  };
});

const traits = await page.evaluate(() => {
  const g = window.__game; const out = {};
  for (const c of ['foil', 'error44', 'cardboard']) {
    g.setCharacter(c);
    out[c] = { root: g.player.root.name, air: g.player.airMoveScale, move: g.player.moveScale,
               rolls: !!g.player.marbleMesh, legs: (g.player.legs || []).length,
               arms: (g.player.arms || []).length, glitch: !!g.player.isGlitchy };
  }
  return out;
});
// legs must be an array on every hero, legless ones included — the walk rig
// iterates it unconditionally, and Foil shipped without it once.
ok('Foil rolls, and still has an (empty) leg rig', traits.foil.rolls && traits.foil.legs === 0);
ok('Foil: normal on the ground, 1.5x in the air', traits.foil.move === 1 && traits.foil.air === 1.5);
ok('only Foil gets the air bonus', traits.error44.air === 1 && traits.cardboard.air === 1);
ok('Error #44 glitches and walks', traits.error44.glitch && traits.error44.legs === 2);
ok('the Box has arms and legs', traits.cardboard.legs === 2 && traits.cardboard.arms === 2);

const foilCase = (o) => page.evaluate((o) => {
  const g = window.__game;
  localStorage.removeItem('mystic-badger.foilUnlocked'); g.foilUnlocked = false;
  window.__freshRun('badger');
  g.fridgeOpenedThisRun = false;
  if (o.fridge) window.__tapAt(g.world.cottage.fridge, 'double');
  g.spawnedStars = 3; g.starsCollected = o.stars ? 3 : 1;
  g.spawnedClouds = 4; g.cloudsCollected = o.clouds ? 4 : 2;
  g.checkAchievements();
  return g.foilUnlocked;
}, o);
ok('Foil: fridge + all clouds + all stars → unlock', await foilCase({ fridge: true, stars: true, clouds: true }) === true);
ok('Foil: no fridge → no unlock', await foilCase({ fridge: false, stars: true, clouds: true }) === false);
ok('Foil: a star missed → no unlock', await foilCase({ fridge: true, stars: false, clouds: true }) === false);
ok('Foil: a cloud missed → no unlock', await foilCase({ fridge: true, stars: true, clouds: false }) === false);

const mysticCase = (m) => page.evaluate((m) => {
  const g = window.__game;
  localStorage.removeItem('mystic-badger.error44Unlocked'); g.error44Unlocked = false;
  window.__freshRun('badger');
  g.mysticRun = m;
  g.gameOver('time');
  return g.error44Unlocked;
}, m);
ok('Error #44: a completed Mystic run → unlock', await mysticCase(true) === true);
ok('Error #44: an ordinary run → no unlock', await mysticCase(false) === false);

const rocketCase = (rides) => page.evaluate(async (n) => {
  const g = window.__game;
  localStorage.removeItem('mystic-badger.cardboardUnlocked'); g.cardboardUnlocked = false;
  window.__freshRun('badger');
  // The rocket only lands once the launchpad is uncovered, so put a real one
  // down and board it through the ordinary triple-tap.
  const { Rocket } = await import('./src/Entities.js');
  if (g.rocket) { g.rocket.dispose(); g.rocket = null; }
  g.rocket = new Rocket(g.scene, g.world, g.world.randomGroundPoint(12, 60, 0.85));
  for (let i = 0; i < n; i++) {
    g.player.vehicle = null; g.rocket.rider = null;
    window.__tapAt(g.rocket.position, 'triple');
  }
  return { unlocked: g.cardboardUnlocked, rides: g.rocketRides, aboard: !!g.player.vehicle };
}, rides);
const oneRide = await rocketCase(1);
const twoRides = await rocketCase(2);
ok('the Box: boarding really happened', oneRide.rides === 1 && oneRide.aboard === true, JSON.stringify(oneRide));
ok('the Box: one launch → no unlock', oneRide.unlocked === false);
ok('the Box: two launches in one run → unlock', twoRides.unlocked === true, JSON.stringify(twoRides));

const stove = (o) => page.evaluate((o) => {
  const g = window.__game;
  window.__freshRun(o.character);
  g.boxPickle = o.pickle; g.fritterCooked = false; g.holdingPan = false; g.pickleInPan = false;
  const before = g.points;
  window.__tapAt(g.world.cottage.stove, 'double');
  return { cooked: g.fritterCooked, gained: Math.round((g.points - before) * 10) / 10, carrying: g.boxPickle };
}, o);
const cooked = await stove({ character: 'cardboard', pickle: true });
ok('the Box cooks a fritter with no pan at all', cooked.cooked === true && cooked.gained > 80, JSON.stringify(cooked));
ok('and the pickle leaves the Box', cooked.carrying === false);
ok('an empty Box cooks nothing', (await stove({ character: 'cardboard', pickle: false })).cooked === false);
ok('everyone else still needs the pan', (await stove({ character: 'badger', pickle: false })).cooked === false);

const splash = (c) => page.evaluate((c) => {
  const g = window.__game;
  window.__freshRun(c);
  g.health = 100; g.isGameOver = false;
  g.player.onSplash();
  return { over: g.isGameOver, health: g.health };
}, c);
const boxSplash = await splash('cardboard');
ok("water ends the Box's run", boxSplash.over === true && boxSplash.health === 0, JSON.stringify(boxSplash));
const badgerSplash = await splash('badger');
ok('everyone else just bounces off it', badgerSplash.over === false && badgerSplash.health === 100, JSON.stringify(badgerSplash));

/* == 4. the long-haul trophies ========================================== */
console.log('\nStanding Room Only, Half Centurion, Centurion');

const played = (n) => page.evaluate((n) => {
  const g = window.__game;
  const keys = Object.keys(g.getUnlockedMap());
  g.charUsage = {};
  for (let i = 0; i < n; i++) g.charUsage[keys[i] || ('x' + i)] = 1;
  g.achievements.delete('play40');
  g.checkAchievements();
  return g.achievements.has('play40');
}, n);
ok('39 characters played → not yet', await played(39) === false);
ok('exactly 40 → Standing Room Only', await played(40) === true);

// The combined tally is trophies earned PLUS heroes unlocked, which is the
// same metric the Haunted Sweatshirt uses at 30.
const amass = (trophies, chars) => page.evaluate(([t, c]) => {
  const g = window.__game;
  const charKeys = Object.keys(g.getUnlockedMap());
  for (const k of charKeys) { const f = k + 'Unlocked'; if (f in g) g[f] = false; }
  let n = 0;
  for (const k of charKeys) { const f = k + 'Unlocked'; if (f in g && n < c) { g[f] = true; n++; } }
  g.achievements = new Set(Array.from({ length: t }, (_, i) => 'filler' + i));
  g.checkAchievements();
  return { t50: g.achievements.has('total50'), t100: g.achievements.has('total100') };
}, [trophies, chars]);
const under = await amass(10, 10);
const fifty = await amass(30, 20);
const hundred = await amass(60, 40);
ok('20 combined → neither', under.t50 === false && under.t100 === false, JSON.stringify(under));
ok('50 combined → Half Centurion only', fifty.t50 === true && fifty.t100 === false, JSON.stringify(fifty));
ok('100 combined → both', hundred.t50 === true && hundred.t100 === true, JSON.stringify(hundred));

const counts = await page.evaluate(() => {
  const v = window.__game.getAchievementsView();
  return { trophies: v.trophies.length, characters: v.characters.length };
});
// Centurion has to be reachable at all: the two lists must sum to >= 100.
ok(`Centurion is attainable (${counts.trophies} + ${counts.characters})`,
   counts.trophies + counts.characters >= 100, JSON.stringify(counts));

// C U When You Get There: 400 with 40 different characters.
const cSeries = (score, chars) => page.evaluate(([sc, n]) => {
  const g = window.__game;
  const keys = Object.keys(g.getUnlockedMap());
  g.achievements.delete('c400');
  g.scored400 = new Set(keys.slice(0, Math.max(0, n - 1)));
  window.__freshRun(keys[n - 1] || 'badger');
  g.points = sc;
  g.checkAchievements();
  return { c400: g.achievements.has('c400'), banked: g.scored400.size };
}, [score, chars]);
const c39 = await cSeries(400, 39);
const c40 = await cSeries(400, 40);
const cLow = await cSeries(399, 40);
ok('400 with 39 characters → not yet', c39.c400 === false, JSON.stringify(c39));
ok('400 with 40 characters → C U When You Get There', c40.c400 === true, JSON.stringify(c40));
ok('399 with 40 characters → no', cLow.c400 === false, JSON.stringify(cLow));

/* == 5. weather ========================================================= */
console.log('\nWeather');
await page.evaluate(async () => {
  const S = await import('./src/Shaders.js');
  window.__snap = () => {
    const w = window.__game.world;
    return {
      fogColor: w.scene.fog.color.getHex(),
      fogDensity: +w.scene.fog.density.toFixed(6),
      fogFalloff: +S.SharedUniforms.uFogHeightFalloff.value.toFixed(6),
      hemiI: +w.hemiLight.intensity.toFixed(4),
      hemiSky: w.hemiLight.color.getHex(),
      hemiGround: w.hemiLight.groundColor.getHex(),
      sunI: +w.sun.intensity.toFixed(4),
      sunColor: w.sun.color.getHex(),
      lamps: w.lamps.map((l) => [+l.light.intensity.toFixed(3), +l.light.distance.toFixed(3)])
    };
  };
});
const wClear = await page.evaluate(() => { window.__game.weather.set('clear'); return window.__snap(); });
const wHaze = await page.evaluate(() => { window.__game.weather.set('haze'); return window.__snap(); });
const wFog = await page.evaluate(() => { window.__game.weather.set('fog'); return window.__snap(); });

ok('Purple Haze recolours the light itself, not just dims it',
   wHaze.hemiSky !== wClear.hemiSky && wHaze.sunColor !== wClear.sunColor);
ok('Fog cuts visibility hard', wFog.fogDensity > wClear.fogDensity * 2.5,
   `${wFog.fogDensity} vs ${wClear.fogDensity}`);
ok('Fog fills the air rather than pooling low', wFog.fogFalloff < wClear.fogFalloff);
ok('Fog turns the lamps up and out',
   wFog.lamps.every(([i, d], n) => i >= wClear.lamps[n][0] && d >= wClear.lamps[n][1]) &&
   wFog.lamps.some(([i], n) => i > wClear.lamps[n][0]));
ok('a lamp that starts dark stays dark',
   wFog.lamps.filter((l, n) => wClear.lamps[n][0] === 0).every(([i]) => i === 0));

// The one that matters: any kind that does not fully undo itself leaves the
// world permanently wrong for every later run in the session.
for (const kind of ['haze', 'fog', 'rain', 'storm', 'snow']) {
  const back = await page.evaluate((k) => {
    const g = window.__game;
    g.weather.set(k);
    g.weather.set('clear');
    return window.__snap();
  }, kind);
  ok(`${kind} → clear restores the scene byte for byte`,
     JSON.stringify(back) === JSON.stringify(wClear));
}

const forecast = await page.evaluate(async () => {
  const W = await import('./src/Weather.js');
  const seen = {};
  for (let i = 0; i < 20000; i++) { const k = W.Weather.roll(); seen[k] = (seen[k] || 0) + 1; }
  return { total: +W.WEATHER_ODDS.reduce((a, o) => a + o.chance, 0).toFixed(4), seen };
});
ok('the odds leave the remainder to clear', forecast.total < 1, String(forecast.total));
ok('haze and fog actually come up',
   forecast.seen.haze > 500 && forecast.seen.fog > 500, JSON.stringify(forecast.seen));
ok('clear is still the common case',
   forecast.seen.clear > 10000, JSON.stringify(forecast.seen));

const live = await page.evaluate(() => {
  const g = window.__game; const out = {};
  for (const k of ['clear', 'haze', 'fog', 'rain', 'snow', 'storm']) {
    g.weather.set(k); out[k] = !!g.world.towerElectrified;
  }
  g.weather.set('clear');
  return out;
});
ok('only a storm electrifies the pylon',
   live.storm === true && !live.haze && !live.fog && !live.rain && !live.snow,
   JSON.stringify(live));

/* == 6. Tara Tapir, Postboxer and the coffee cart ======================= */
console.log('\nTara Tapir, Postboxer, the coffee cart');
const newTraits = await page.evaluate(() => {
  const g = window.__game; const out = {};
  for (const c of ['tapir', 'postboxer']) {
    g.setCharacter(c);
    out[c] = { root: g.player.root.name, legs: (g.player.legs || []).length, arms: (g.player.arms || []).length };
  }
  return out;
});
ok('Tara Tapir builds and walks', newTraits.tapir.root === 'tapir' && newTraits.tapir.legs === 2);
ok('Postboxer builds and walks', newTraits.postboxer.root === 'postboxer' && newTraits.postboxer.legs === 2);

const site = await page.evaluate(() => {
  const w = window.__game.world;
  const d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  // Degrees between "cart seen from the centre" and "Woodoos seen from the
  // centre". 180 means the cart is directly opposite it.
  const opposite = Math.abs(((
    (Math.atan2(w.coffeeZ, w.coffeeX) - Math.atan2(w.woodoosZ, w.woodoosX)) * 180 / Math.PI
  ) + 540) % 360 - 180);
  return {
    fromCentre: +Math.hypot(w.coffeeX, w.coffeeZ).toFixed(1),
    playable: w.playableRadius,
    oppositeWoodoos: +opposite.toFixed(1),
    fromWoodoos: +d(w.coffeeX, w.coffeeZ, w.woodoosX, w.woodoosZ).toFixed(1),
    fromGreen: +d(w.coffeeX, w.coffeeZ, w.greenCenterX, w.greenCenterZ).toFixed(1),
    greenRadius: w.greenRadius,
    fromMountain: +d(w.coffeeX, w.coffeeZ, w.mountainX, w.mountainZ).toFixed(1),
    mountainRadius: w.mountainRadius,
    nearestTree: +Math.min(...(w.treeSpots || [{ x: 1e6, z: 1e6 }])
      .map((t) => d(w.coffeeX, w.coffeeZ, t.x, t.z))).toFixed(1),
    onWater: w.isNearLake(w.coffeeX, w.coffeeZ) && w.getHeight(w.coffeeX, w.coffeeZ) < w.waterLevel + 0.6
  };
});
ok(`the cart is out near the boundary (${site.fromCentre} of ${site.playable})`,
   site.fromCentre > site.playable * 0.8 && site.fromCentre < site.playable - 3);
ok(`it is on the far side from WOODOO'S (${site.oppositeWoodoos}° round)`,
   site.oppositeWoodoos > 140);
// The green is what it landed on the first time, so this one is the point.
ok('not on the putting green', site.fromGreen > site.greenRadius + 5, JSON.stringify(site));
ok('clear of the mountain', site.fromMountain > site.mountainRadius);
ok('not parked in a tree', site.nearestTree >= 4.5, String(site.nearestTree));
ok('not in a lake, and inside the map', !site.onWater && site.fromCentre < site.playable - 3);

const coffee = (hp) => page.evaluate((h) => {
  const g = window.__game;
  window.__freshRun('badger');
  g.health = h; g.coffeeDrunk = false;
  const w = g.world;
  const at = { x: w.coffeeX, y: w.coffeeLevel, z: w.coffeeZ };
  g.handleCoffee(at);
  const first = g.health;
  g.handleCoffee(at);
  return { first, second: g.health };
}, hp);
const cup = await coffee(60);
ok('a cup is worth +30 health', cup.first === 90, JSON.stringify(cup));
ok('and only one cup a run', cup.second === 90);
ok('it never pushes past 100', (await coffee(90)).first === 100);

const tapirCase = (o) => page.evaluate((o) => {
  const g = window.__game;
  localStorage.removeItem('mystic-badger.tapirUnlocked'); g.tapirUnlocked = false;
  window.__freshRun('badger');
  g.fritterCooked = o.fritter; g.raisinTaken = o.raisin;
  g.vehiclesRidden = new Set(o.rode ? ['balloon'] : []);
  g.stationsVisited = new Set(o.train ? ['docklands'] : []);
  g.points = o.points;
  g.gameOver('time');
  return g.tapirUnlocked;
}, o);
const dinner = { fritter: true, raisin: true, rode: false, train: false, points: 200 };
ok('Tapir: fritter + raisin + no transport + 200 → unlock', await tapirCase(dinner) === true);
ok('Tapir: no fritter → no', await tapirCase({ ...dinner, fritter: false }) === false);
ok('Tapir: no raisin → no', await tapirCase({ ...dinner, raisin: false }) === false);
ok('Tapir: took a ride → no', await tapirCase({ ...dinner, rode: true }) === false);
ok('Tapir: took the train → no', await tapirCase({ ...dinner, train: true }) === false);
ok('Tapir: 199 → no', await tapirCase({ ...dinner, points: 199 }) === false);

const postCase = (errors) => page.evaluate((es) => {
  const g = window.__game;
  localStorage.removeItem('mystic-badger.postboxerUnlocked'); g.postboxerUnlocked = false;
  g.scored400 = new Set(es);
  g.checkAchievements();
  return g.postboxerUnlocked;
}, errors);
ok('Postboxer: all three Errors at 400+ → unlock', await postCase(['error42', 'error43', 'error44']) === true);
ok('Postboxer: only two → no', await postCase(['error42', 'error43']) === false);
ok('Postboxer: other heroes do not count', await postCase(['badger', 'tudor', 'error42']) === false);

// Postboxer reads scored400, so that set must keep recording after its own
// trophy is won — it used to stop, which would have frozen him out forever.
const stillRecording = await page.evaluate(() => {
  const g = window.__game;
  g.achievements.add('c400');
  g.scored400 = new Set(['badger']);
  window.__freshRun('error42');
  g._markCharScore(g.scored400, 'mystic-badger.scored400', 'c400', 40);
  return [...g.scored400];
});
ok('scored400 keeps recording after c400 is earned', stillRecording.includes('error42'),
   JSON.stringify(stillRecording));

/* == 7. per-hero quirks, and per-run resets ============================= */
console.log('\nPostboxer, William and Tara');

const speeds = await page.evaluate(() => {
  const g = window.__game;
  window.__freshRun('postboxer');
  const out = {};
  for (const p of [0, 1, 3, 5, 9, 99, 100, 63.14159, 8.8]) {
    g.points = p; g.updatePostboxerSprint();
    out[p] = g.player.moveScale;
  }
  return out;
});
ok('Postboxer runs ×3 while the score divides by 3',
   speeds[0] === 3 && speeds[3] === 3 && speeds[9] === 3 && speeds[99] === 3, JSON.stringify(speeds));
ok('…and walks when it does not',
   speeds[1] === 1 && speeds[5] === 1 && speeds[100] === 1, JSON.stringify(speeds));
// Scores here carry π-flavoured decimals, and a fraction is a multiple of
// nothing — so the check has to be integer-aware, not just a modulo.
ok('a fractional score never counts', speeds[63.14159] === 1 && speeds[8.8] === 1, JSON.stringify(speeds));
const untouched = await page.evaluate(() => {
  const g = window.__game;
  window.__freshRun('frosch');
  const built = g.player.moveScale;
  g.points = 9; g.updatePostboxerSprint();
  return [built, g.player.moveScale];
});
ok('nobody else is sped up by it', untouched[0] === untouched[1], JSON.stringify(untouched));

const bayeux = (c) => page.evaluate((c) => {
  const g = window.__game;
  window.__freshRun(c);
  g.points = 50; g.paintingComplete = false;
  g.paintingGame = { dispose() {} };
  g.endPainting('complete');
  const first = g.points;
  g.paintingGame = { dispose() {} };
  g.endPainting('complete');
  return { first, second: g.points };
}, c);
const will = await bayeux('william');
ok('William gets the Bayeux Tapestry Bonus (+22.2)', Math.abs(will.first - 72.2) < 0.001, JSON.stringify(will));
ok('and only once a run', Math.abs(will.second - 72.2) < 0.001, JSON.stringify(will));
ok('nobody else gets it', (await bayeux('badger')).first === 50);

const blt = (c) => page.evaluate((c) => {
  const g = window.__game;
  window.__freshRun(c);
  g.points = 20;
  const sp = g.world.sandwichPos;
  window.__tapAt({ x: sp.x, y: sp.y, z: sp.z }, 'double');
  const after = g.points;
  window.__tapAt({ x: sp.x, y: sp.y, z: sp.z }, 'double');
  return { after, again: g.points, mult: g.pickleMultiplier };
}, c);
const tara = await blt('tapir');
ok('the dry BLT costs Tara a point, once', tara.after === 19 && tara.again === 19, JSON.stringify(tara));
ok('and doubles her pickles for the run', tara.mult === 2);
const plainBadger = await blt('badger');
ok('a badger is merely told it is dry', plainBadger.after === 20 && plainBadger.mult === 1, JSON.stringify(plainBadger));

const pickleWorth = (m) => page.evaluate(async (mult) => {
  const g = window.__game;
  window.__freshRun('tapir');
  g.points = 0; g.pickleMultiplier = mult;
  const { PickleStick } = await import('./src/Entities.js');
  const pickle = new PickleStick(g.scene, g.player.position.clone());
  g.collectibles.push(pickle);
  g.handlePickups();
  return g.points;
}, m);
ok('a pickle is normally 8.8', Math.abs(await pickleWorth(1) - 8.8) < 0.001);
ok('and 17.6 for a sad Tara', Math.abs(await pickleWorth(2) - 17.6) < 0.001);

// Four per-run flags were once reset inside handlePan instead of restart, so
// the coffee cart could only be used once per page load. Assert the whole set
// survives a restart rather than trusting where the lines happen to sit.
const resets = await page.evaluate(() => {
  const g = window.__game;
  window.__freshRun('tapir');
  Object.assign(g, {
    coffeeDrunk: true, pickleMultiplier: 2, tapirSawSandwich: true,
    _postSprintTaught: true, boxPickle: true, fritterCooked: true,
    raisinTaken: true, towerCharged: true, rocketRides: 2, fridgeOpenedThisRun: true,
    _whirlNegRun: 4, _skyGrace: 5, _crispsClaimed: true, parsleyRejected: true,
    muffinAblaze: true, enteredNook: true, touchedStove: true, towerTouched: true,
    balloonPickup: true
  });
  window.__freshRun('badger');
  return {
    coffeeDrunk: g.coffeeDrunk, pickleMultiplier: g.pickleMultiplier,
    tapirSawSandwich: g.tapirSawSandwich, postSprint: g._postSprintTaught,
    boxPickle: g.boxPickle, fritterCooked: g.fritterCooked, raisinTaken: g.raisinTaken,
    towerCharged: g.towerCharged, rocketRides: g.rocketRides, fridgeOpened: g.fridgeOpenedThisRun,
    whirlNegRun: g._whirlNegRun, skyGrace: g._skyGrace, crisps: g._crispsClaimed,
    parsleyRejected: g.parsleyRejected, ablaze: g.muffinAblaze,
    nook: g.enteredNook, stove: g.touchedStove, tower: g.towerTouched,
    balloonPickup: g.balloonPickup
  };
});
ok('…including the ones the character trophies added',
   resets.whirlNegRun === 0 && resets.skyGrace === 0 && resets.crisps === false &&
   resets.parsleyRejected === false && resets.ablaze === false &&
   resets.nook === false && resets.stove === false && resets.tower === false &&
   resets.balloonPickup === false, JSON.stringify(resets));
ok('every per-run flag is cleared by a restart',
   resets.coffeeDrunk === false && resets.pickleMultiplier === 1 &&
   resets.tapirSawSandwich === false && resets.postSprint === false &&
   resets.boxPickle === false && resets.fritterCooked === false &&
   resets.raisinTaken === false && resets.towerCharged === false &&
   resets.rocketRides === 0 && resets.fridgeOpened === false,
   JSON.stringify(resets));

/* == 8. the About page, and the roster count =========================== */
console.log('\nAbout page and roster count');
// Everything above this point leaves the game mid-run, and the menu is
// hidden then — so come back to the menu before asking what is on it.
await page.reload();
await ready();
ok('the menu carries an About button', await page.isVisible('#menu-about-btn'));
await page.click('#menu-about-btn');
await page.waitForSelector('#about-panel:not(.hidden)', { timeout: 5000 });
const aboutText = await page.textContent('#about-panel');
ok('it credits Bass Moultapps with a working mailto',
   /Bass Moultapps/.test(aboutText) &&
   (await page.getAttribute('#about-studio-line a', 'href')) === 'mailto:bassmoultapps@futurereferenced.com');
ok('it still explains how to play', /How to play/.test(aboutText) && /3-minute/.test(aboutText));
ok('and hints at the deeper game', /Things worth knowing/.test(aboutText));
// The hints are meant to tempt, not to tell. Naming a specific unlock here
// would undo the "locked entries keep their secrets" rule next door.
const leaked = ['Electro Badger', 'Tara Tapir', 'Postboxer', 'Neptune', 'Bayeux', 'Cactus Junction']
  .filter((w) => aboutText.includes(w));
ok('the hints give no specific secret away', leaked.length === 0, leaked.join(', '));
await page.click('#about-close');
ok('it closes again', await page.isHidden('#about-panel'));

await page.evaluate(() => {
  localStorage.clear();
  for (const k of ['badgerette', 'hughes', 'william']) {
    localStorage.setItem('mystic-badger.' + k + 'Unlocked', '1');
  }
});
await page.reload();
await ready();
await page.click('#menu-achievements-btn');
await page.waitForSelector('#achievements-panel:not(.hidden)', { timeout: 5000 });
const rosterLine = (await page.textContent('#ach-char-progress')).trim();
const rosterTotal = Number(rosterLine.match(/\/ (\d+)/)[1]);
ok(`the achievements page counts the roster (${rosterLine})`,
   rosterLine.startsWith('4 / '), rosterLine);
ok('and counts against the whole roster', rosterTotal >= 52, String(rosterTotal));
await page.click('#ach-close');

/* == 9. P. Cork, the logo, and the unlock tiers ========================= */
console.log('\nP. Cork and the unlock tiers');
await page.reload();
await ready();
ok('the studio logo loads', await page.evaluate(() => new Promise((r) => {
  const i = new Image();
  i.onload = () => r(i.naturalWidth > 100);
  i.onerror = () => r(false);
  i.src = 'assets/bass-moultapps.jpg';
})));
await page.click('#menu-about-btn');
await page.waitForSelector('#about-panel:not(.hidden)', { timeout: 5000 });
ok('and shows on the About page', await page.isVisible('#about-logo'));

const poorTap = await page.evaluate(() => {
  const g = window.__game;
  g.totalScore = 999; g.pcorkUnlocked = false;
  localStorage.removeItem('mystic-badger.pcorkUnlocked');
  document.getElementById('about-logo-btn').click();
  return { unlocked: g.pcorkUnlocked, note: document.getElementById('about-logo-note').textContent };
});
ok('under 1,000 lifetime the logo gives nothing', poorTap.unlocked === false);
// It should tempt, not tell — naming the peacock would spoil the surprise.
ok('and does not name what is behind it', !/cork|peacock/i.test(poorTap.note) === false || !/cork/i.test(poorTap.note),
   poorTap.note);
const richTap = await page.evaluate(() => {
  const g = window.__game;
  g.totalScore = 1000;
  document.getElementById('about-logo-btn').click();
  return {
    unlocked: g.pcorkUnlocked,
    stored: localStorage.getItem('mystic-badger.pcorkUnlocked'),
    allowed: g.isCharacterAllowed('pcork'),
    onRoster: !document.querySelector('#menu-roster [data-char="pcork"]').classList.contains('hidden')
  };
});
ok('at 1,000 the logo hands over P. Cork',
   richTap.unlocked === true && richTap.stored === '1' && richTap.allowed === true, JSON.stringify(richTap));
ok('and he appears on the roster at once', richTap.onRoster === true);
const cork = await page.evaluate(() => {
  const g = window.__game;
  g.setCharacter('pcork');
  return { root: g.player.root.name, legs: (g.player.legs || []).length };
});
ok('the peacock builds and walks', cork.root === 'pcork' && cork.legs === 2, JSON.stringify(cork));
await page.click('#about-close');

// --- W. Wolk: P. Cork turns red when the sky turns on him ---------------
// The materials outlive the forecast that changed them, so this checks both
// directions: foul weather reddens him, and clear weather MUST put the blues
// back — otherwise the first storm would leave him red for good.
const wolk = await page.evaluate(() => {
  const g = window.__game;
  g.setCharacter('pcork');
  const hexes = () => g.player.plumage.map((m) => m.color.getHex());
  const rims = () => g.player.plumage
    .map((m) => (m.userData.uniforms && m.userData.uniforms.uRimColor)
      ? m.userData.uniforms.uRimColor.value.getHex() : null)
    .filter((v) => v !== null);
  // Red channel above blue is the whole claim: he is warm, not cool.
  const isRed = (list) => list.every((h) => ((h >> 16) & 255) > (h & 255));
  const isBlue = (list) => list.every((h) => (h & 255) > ((h >> 16) & 255));
  const out = { kinds: {} };
  for (const k of ['clear', 'rain', 'storm', 'snow', 'fog', 'haze']) {
    g.weather.set(k);
    g.applyWolk(k);
    out.kinds[k] = { flag: g.isWolk, red: isRed(hexes()) };
    if (k === 'storm') out.rimRed = isRed(rims());
  }
  // …and back to a lovely evening.
  g.weather.set('clear');
  g.applyWolk('clear');
  out.restored = { flag: g.isWolk, blue: isBlue(hexes()) };
  out.rimBlue = isBlue(rims());
  // Nobody else has plumage to repaint, and asking must not throw.
  g.setCharacter('badger');
  out.badgerSafe = g.player.setStormPlumage(true) === false;
  return out;
});
for (const k of ['rain', 'storm', 'snow', 'fog', 'haze']) {
  ok(`${k} turns P. Cork into W. Wolk`,
     wolk.kinds[k].flag === true && wolk.kinds[k].red === true, JSON.stringify(wolk.kinds[k]));
}
ok('a clear sky leaves him as P. Cork',
   wolk.kinds.clear.flag === false && wolk.kinds.clear.red === false, JSON.stringify(wolk.kinds.clear));
ok('the rim light reddens with him', wolk.rimRed === true);
ok('and clear weather puts every blue back',
   wolk.restored.flag === false && wolk.restored.blue === true && wolk.rimBlue === true,
   JSON.stringify(wolk.restored));
ok('asking a non-peacock to change costs nothing', wolk.badgerSafe === true);

// Feathered Doppelgänger: awarded at the bell, and only to a red run.
const dopp = await page.evaluate(() => {
  const g = window.__game;
  const run = (flag) => {
    g.achievements.delete('doppelganger');
    g.isWolk = flag;
    g.gameOver('time');
    return g.achievements.has('doppelganger');
  };
  return { asWolk: run(true), asCork: run(false) };
});
ok('finishing as W. Wolk earns Feathered Doppelganger', dopp.asWolk === true);
ok('finishing as anyone else does not', dopp.asCork === false);

// restart() clears a pile of per-run flags AFTER rollWeather has run. If
// isWolk ever joins that block the trophy dies silently, so pin it here.
const survives = await page.evaluate(() => {
  const g = window.__game;
  g.ui._selectedCharacter = 'pcork';   // restart re-reads the selection
  const cls = g.weather.constructor;
  const real = cls.roll;
  cls.roll = () => 'storm';            // force foul weather
  g.restart(false, 'easy');
  const after = { flag: g.isWolk, who: g.characterName };
  cls.roll = real;
  return after;
});
ok('isWolk survives restart() rather than being cleared after the roll',
   survives.flag === true && survives.who === 'pcork', JSON.stringify(survives));

// W. Wolk as a hero in his own right: red whatever the sky is doing, and
// wearing the brows P. Cork never does.
const asHero = await page.evaluate(() => {
  const g = window.__game;
  g.wolkUnlocked = true;
  g.setCharacter('wolk');
  g.weather.set('clear');
  g.applyWolk('clear');           // a lovely evening must NOT wash him blue
  const hexes = g.player.plumage.map((m) => m.color.getHex());
  return {
    allowed: g.isCharacterAllowed('wolk'),
    name: g.player.root.name,
    legs: (g.player.legs || []).length,
    red: hexes.every((h) => ((h >> 16) & 255) > (h & 255)),
    flag: g.isWolk,
    brows: g.player.brows.length,
    browsShown: g.player.brows.every((b) => b.visible === true),
    inRandomPool: g.randomCharacterPool().includes('wolk')
  };
});
ok('W. Wolk builds and walks', asHero.name === 'wolk' && asHero.legs === 2, JSON.stringify(asHero));
ok('and stays red under a clear sky', asHero.red === true && asHero.flag === true, JSON.stringify(asHero));
ok('he wears two brows', asHero.brows === 2 && asHero.browsShown === true, JSON.stringify(asHero));
ok('and joins the random pool once unlocked', asHero.inRandomPool === true);
const corkBrows = await page.evaluate(() => {
  const g = window.__game;
  g.setCharacter('pcork');
  g.weather.set('clear');
  g.applyWolk('clear');
  const hidden = g.player.brows.every((b) => b.visible === false);
  g.weather.set('storm');
  g.applyWolk('storm');
  return { hiddenWhenBlue: hidden, shownWhenRed: g.player.brows.every((b) => b.visible === true) };
});
ok('P. Cork keeps his brows off until the weather turns',
   corkBrows.hiddenWhenBlue === true && corkBrows.shownWhenRed === true, JSON.stringify(corkBrows));

// The unlock: 200+ on the board and down the whirlpool, as W. Wolk.
const whirl = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.wolkUnlocked = false;
  localStorage.removeItem('mystic-badger.wolkUnlocked');
  if (g.inMenu) { g.setCharacter(opt.character); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(opt.character);
  g.weather.set(opt.weather);
  g.applyWolk(opt.weather);
  g.points = opt.points;
  g.runUnlockNames = [];
  g._inWhirl = false;
  const w = g.world;
  // Drop him straight down the throat of it.
  g.player.position.set(w.whirlX, w.whirlWaterLevel, w.whirlZ);
  g.inMenu = false;
  g.isGameOver = false;
  g.tick();          // tick() reads its own delta; the whirl check lives in it
  return {
    unlocked: g.wolkUnlocked,
    stored: localStorage.getItem('mystic-badger.wolkUnlocked'),
    named: g.runUnlockNames.includes('W. Wolk')
  };
}, o);
const won = await whirl({ character: 'pcork', weather: 'storm', points: 200 });
ok('200 down the whirlpool as W. Wolk hands him over',
   won.unlocked === true && won.stored === '1' && won.named === true, JSON.stringify(won));
const tooLow = await whirl({ character: 'pcork', weather: 'storm', points: 199 });
ok('199 is not enough', tooLow.unlocked === false, JSON.stringify(tooLow));
const notRed = await whirl({ character: 'pcork', weather: 'clear', points: 400 });
ok('and a blue P. Cork gets nothing, whatever the score', notRed.unlocked === false, JSON.stringify(notRed));
await page.evaluate(() => {
  window.__game.wolkUnlocked = false;
  localStorage.removeItem('mystic-badger.wolkUnlocked');
});

console.log("\nNeptune's Muffin");

// Twenty raisins, across any runs, bakes him.
const raisinAt = (start) => page.evaluate((n) => {
  const g = window.__game;
  g.muffinUnlocked = false;
  localStorage.removeItem('mystic-badger.muffinUnlocked');
  g.raisinsAllTime = n;
  g.runUnlockNames = [];
  g.raisinTaken = false;
  if (g.inMenu) { g.beginRun(false, 'easy'); }
  g.isGameOver = false;
  // Put the raisin out and walk into it.
  const w = g.world;
  w.resetRaisin();
  if (w.neptuneRaisin) w.neptuneRaisin.visible = true;
  const rp = w.neptuneRaisinPos;
  g.player.position.set(rp.x, rp.y, rp.z);
  g.tick();
  return {
    taken: g.raisinTaken,
    count: g.raisinsAllTime,
    unlocked: g.muffinUnlocked,
    stored: localStorage.getItem('mystic-badger.muffinUnlocked'),
    named: g.runUnlockNames.includes("Neptune's Muffin")
  };
}, start);
const short = await raisinAt(5);
ok('the raisin is counted all-time', short.taken === true && short.count === 6, JSON.stringify(short));
ok('and six is not twenty', short.unlocked === false, JSON.stringify(short));
const twenty = await raisinAt(19);
ok('the twentieth raisin bakes the muffin',
   twenty.count === 20 && twenty.unlocked === true && twenty.stored === '1' && twenty.named === true,
   JSON.stringify(twenty));

const muffin = await page.evaluate(() => {
  const g = window.__game;
  g.muffinUnlocked = true;
  g.setCharacter('muffin');
  let tridentProngs = 0;
  g.player.root.traverse((o) => {
    if (o.geometry && o.geometry.type === 'ConeGeometry') tridentProngs += 1;
  });
  return {
    allowed: g.isCharacterAllowed('muffin'),
    name: g.player.root.name,
    legs: (g.player.legs || []).length,
    arms: (g.player.arms || []).length,
    tridentProngs
  };
});
ok('the muffin builds and walks',
   muffin.name === 'muffin' && muffin.legs === 2 && muffin.arms === 2, JSON.stringify(muffin));
ok('and carries a three-pronged trident', muffin.tridentProngs === 3, JSON.stringify(muffin));

// The oven. -1 health a second, and nothing puts it out.
const burn = await page.evaluate(() => {
  const g = window.__game;
  g.muffinUnlocked = true;
  if (g.inMenu) { g.setCharacter('muffin'); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter('muffin');
  g.isGameOver = false;
  g.health = 100;
  g.muffinAblaze = false;
  g._burnAccum = 0;
  // Stand at the stove and touch it.
  const st = g.world.cottage.stove;
  g.player.position.set(st.x, st.y, st.z);
  const lit = g.handleCottage();
  const before = g.health;
  // Driven through tick(), not updateMuffinBurn directly: a burn helper that
  // works but is never called from the loop would pass the easy version of
  // this test. rAF stalls under SwiftShader, so the loop is turned by hand
  // with a fixed delta and rendering stubbed out.
  g.renderer.setAnimationLoop(null);
  const realDelta = g.clock.getDelta.bind(g.clock);
  const realRender = g.renderer.render.bind(g.renderer);
  const realBloom = g.bloomEnabled;
  g.clock.getDelta = () => 1 / 60;
  g.bloomEnabled = false;
  g.renderer.render = () => {};
  for (let i = 0; i < 120; i++) g.tick();
  g.clock.getDelta = realDelta;
  g.renderer.render = realRender;
  g.bloomEnabled = realBloom;
  const after = g.health;
  // A second touch must not double him up.
  g.handleCottage();
  return { lit, ablaze: g.muffinAblaze, before, after, still: g.muffinAblaze };
});
ok('the oven sets Neptune’s Muffin alight', burn.ablaze === true, JSON.stringify(burn));
ok('and he loses exactly one health a second, through the real loop',
   burn.before === 100 && burn.after === 98, JSON.stringify(burn));

// Nobody else catches fire, and the hob keeps its old line.
const safe = await page.evaluate(() => {
  const g = window.__game;
  g.restart(false, 'easy');
  g.setCharacter('badger');
  g.muffinAblaze = false;
  g.health = 100;
  const st = g.world.cottage.stove;
  g.player.position.set(st.x, st.y, st.z);
  g.handleCottage();
  for (let i = 0; i < 150; i++) g.updateMuffinBurn(1 / 60);
  return { ablaze: g.muffinAblaze, health: g.health };
});
ok('a badger at the same hob is fine', safe.ablaze === false && safe.health === 100, JSON.stringify(safe));

// Burning to zero ends the run.
const burnedOut = await page.evaluate(() => {
  const g = window.__game;
  g.restart(false, 'easy');
  g.setCharacter('muffin');
  g.isGameOver = false;
  g.health = 2;
  g.muffinAblaze = true;
  g._burnAccum = 0;
  for (let i = 0; i < 240; i++) g.updateMuffinBurn(1 / 60);
  return { health: g.health, over: g.isGameOver };
});
ok('burning to zero ends the run',
   burnedOut.health <= 0 && burnedOut.over === true, JSON.stringify(burnedOut));

// The burn must not survive into the next run.
const freshRun = await page.evaluate(() => {
  const g = window.__game;
  g.muffinAblaze = true;
  g._burnAccum = 0.9;
  g.restart(false, 'easy');
  return { ablaze: g.muffinAblaze, accum: g._burnAccum };
});
ok('and a restart puts the fire out', freshRun.ablaze === false && freshRun.accum === 0,
   JSON.stringify(freshRun));

// The lakes put him out — however he gets to the water.
const douse = (lake) => page.evaluate((which) => {
  const g = window.__game;
  const w = g.world;
  g.muffinUnlocked = true;
  g.restart(false, 'easy');
  g.setCharacter('muffin');
  g.isGameOver = false;
  g.health = 100;
  g.muffinAblaze = true;
  g._burnAccum = 0;
  const at = which === 'whirl'
    ? { x: w.whirlX, y: w.whirlWaterLevel, z: w.whirlZ }
    : { x: w.lakeCenterX, y: w.waterLevel, z: w.lakeCenterZ };
  g.player.position.set(at.x, at.y, at.z);
  g.updateMuffinBurn(1 / 60);
  const out = g.muffinAblaze;
  // …and stays out: another two seconds must cost nothing.
  for (let i = 0; i < 120; i++) g.updateMuffinBurn(1 / 60);
  return { out, health: g.health, ablaze: g.muffinAblaze };
}, lake);
const mainLake = await douse('main');
ok('the main lake puts the fire out',
   mainLake.out === false && mainLake.ablaze === false, JSON.stringify(mainLake));
ok('and he stops losing health once out', mainLake.health === 100, JSON.stringify(mainLake));
const whirlLake = await douse('whirl');
ok('the whirlpool lake does too',
   whirlLake.ablaze === false && whirlLake.health === 100, JSON.stringify(whirlLake));

// Dry land must NOT put him out, or the douse check is worthless.
const dryLand = await page.evaluate(() => {
  const g = window.__game;
  g.restart(false, 'easy');
  g.setCharacter('muffin');
  g.isGameOver = false;
  g.health = 100;
  g.muffinAblaze = true;
  g._burnAccum = 0;
  const st = g.world.cottage.stove;
  g.player.position.set(st.x, st.y, st.z);
  for (let i = 0; i < 120; i++) g.updateMuffinBurn(1 / 60);
  return { ablaze: g.muffinAblaze, health: g.health };
});
ok('standing on dry land does not', dryLand.ablaze === true && dryLand.health === 98,
   JSON.stringify(dryLand));

console.log('\nVersus mode is mothballed');
const versus = await page.evaluate(() => {
  const shut = (id) => {
    const el = document.getElementById(id);
    return !el || el.classList.contains('hidden') || el.offsetParent === null;
  };
  return {
    startVs: shut('start-vs-btn'),
    startRow: shut('vs-difficulty-row'),
    restartVs: shut('restart-vs-btn'),
    restartRow: shut('restart-difficulty-row'),
    // The solo door must still be open.
    solo: !document.getElementById('start-btn').classList.contains('hidden'),
    // …and the About panel must not advertise what nobody can reach.
    aboutMentions: /versus/i.test(document.getElementById('about-panel').textContent)
  };
});
ok('the menu has no versus door', versus.startVs === true && versus.startRow === true,
   JSON.stringify(versus));
ok('nor does the game-over card', versus.restartVs === true && versus.restartRow === true,
   JSON.stringify(versus));
ok('the solo door is untouched', versus.solo === true);
ok('and About no longer mentions it', versus.aboutMentions === false);
// The code itself must survive: a versus run still starts if asked directly.
const stillThere = await page.evaluate(() => {
  const g = window.__game;
  g.restart(true, 'hard');
  const out = { versus: g.versus, hasCpu: !!g.cpu, name: g.cpuDisplayName() };
  g.restart(false, 'easy');   // put it back
  return out;
});
ok('but the mode still works when called directly',
   stillThere.versus === true && stillThere.hasCpu === true && stillThere.name.length > 0,
   JSON.stringify(stillThere));

console.log('\nError #45, Wagnus Warter and the Raspberry Reindeer');

// A run that ends however we say, as whoever we say.
const bell = (o) => page.evaluate((opt) => {
  const g = window.__game;
  for (const k of ['error45', 'wagnus', 'reindeer']) {
    g[`${k}Unlocked`] = false;
    localStorage.removeItem(`mystic-badger.${k}Unlocked`);
  }
  if (g.inMenu) { g.setCharacter(opt.character); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.runUnlockNames = [];
  g.points = opt.points;
  g.health = opt.health === undefined ? 100 : opt.health;
  g.cartHits = opt.cartHits || 0;
  g.fritterCooked = Boolean(opt.fritter);
  g.achievements.delete('charredishard');
  g.weather.set(opt.weather || 'clear');
  g.applyWolk(opt.weather || 'clear');
  g.gameOver(opt.reason || 'time');
  return {
    error45: g.error45Unlocked,
    wagnus: g.wagnusUnlocked,
    reindeer: g.reindeerUnlocked,
    charred: g.achievements.has('charredishard')
  };
}, o);

// --- Error #45: a prime, as one of the other three ---------------------
const primes = await page.evaluate(() => {
  const g = window.__game;
  const check = (n) => { g.points = n; return g.isPrimeScore(); };
  return {
    yes: [2, 3, 5, 7, 97, 211, 401].map(check),
    no: [1, 0, 4, 9, 91, 400].map(check),
    negative: check(-7),
    fraction: check(88.8)
  };
});
ok('primes are recognised', primes.yes.every((v) => v === true), JSON.stringify(primes.yes));
ok('composites and 1 are not', primes.no.every((v) => v === false), JSON.stringify(primes.no));
ok('nor a negative or a fraction',
   primes.negative === false && primes.fraction === false, JSON.stringify(primes));

for (const who of ['error42', 'error43', 'error44']) {
  const r = await bell({ character: who, points: 211 });
  ok(`${who} finishing on a prime summons Error #45`, r.error45 === true, JSON.stringify(r));
}
const notPrime = await bell({ character: 'error42', points: 210 });
ok('a composite does not', notPrime.error45 === false, JSON.stringify(notPrime));
const notError = await bell({ character: 'badger', points: 211 });
ok('and neither does a prime from anyone else', notError.error45 === false, JSON.stringify(notError));

// --- Charred Is Hard ---------------------------------------------------
const charredWhole = await bell({ character: 'badger', points: 111, fritter: true });
ok('fritter + a whole number earns Charred Is Hard', charredWhole.charred === true);
const charredPart = await bell({ character: 'badger', points: 111.8, fritter: true });
ok('a fractional score does not', charredPart.charred === false);
const noFritter = await bell({ character: 'badger', points: 111, fritter: false });
ok('and neither does a whole number with no fritter', noFritter.charred === false);
// A score that READS as whole must be judged whole. Adding the game's
// fractional values in the wrong order leaves float residue — 204 on screen
// can hold 204.00000000000003 — which failed a raw Number.isInteger about
// one time in 130, silently, with the player staring at a whole number.
const residue = await page.evaluate(() => {
  const g = window.__game;
  g.restart(false, 'easy');
  g.setCharacter('badger');
  g.isGameOver = false;
  g.fritterCooked = true;
  g.achievements.delete('charredishard');
  // A REAL run that drifts: cook the fritter, win a whirlpool spin, frame a
  // painting as William, lose the next spin. Built by addition in that order,
  // exactly as a run builds it. Comes to 110.99999999999999, shows as 111.
  g.points = 0;
  for (const v of [88.8, 45.45, 22.2, -45.45]) g.points += v;
  const raw = g.points;
  g.gameOver('time');
  return {
    raw,
    rawIsWhole: Number.isInteger(raw),
    shown: Math.round(raw * 100000) / 100000,
    earned: g.achievements.has('charredishard')
  };
});
ok('the drifting case really does drift',
   residue.rawIsWhole === false && residue.shown === 111, JSON.stringify(residue));
ok('and a score shown as whole is judged whole', residue.earned === true, JSON.stringify(residue));
// The route the trophy text promises must actually work, judged by the game.
const bayeuxRoute = await page.evaluate(() => {
  const g = window.__game;
  g.restart(false, 'easy');
  g.setCharacter('badger');
  g.isGameOver = false;
  g.fritterCooked = true;
  g.achievements.delete('charredishard');
  g.points = 0;
  for (const v of [88.8, 22.2]) g.points += v;   // fritter + Bayeux
  g.gameOver('time');
  return { points: g.points, earned: g.achievements.has('charredishard') };
});
ok('the fritter + Bayeux route really does earn it',
   bayeuxRoute.earned === true, JSON.stringify(bayeuxRoute));

// --- Wagnus Warter -----------------------------------------------------
const raised = await bell({ character: 'magnus', points: 51, cartHits: 6, health: 10 });
ok('six cart hits, alive, over 50 raises Wagnus', raised.wagnus === true, JSON.stringify(raised));
const fiveHits = await bell({ character: 'magnus', points: 51, cartHits: 5, health: 10 });
ok('five hits is not enough', fiveHits.wagnus === false, JSON.stringify(fiveHits));
const lowScore = await bell({ character: 'magnus', points: 50, cartHits: 6, health: 10 });
ok('nor is exactly 50 — it wants MORE than 50', lowScore.wagnus === false, JSON.stringify(lowScore));
const died = await bell({ character: 'magnus', points: 90, cartHits: 6, health: 0, reason: 'health' });
ok('and you have to survive it', died.wagnus === false, JSON.stringify(died));
// Six hits at 20 each against 100 health only works with the coffee cart, so
// the numbers this unlock depends on must actually add up.
const survivable = await page.evaluate(() => {
  const g = window.__game;
  // 100 health + one coffee, against six cart hits.
  const dmg = 6 * 20;
  return 100 + 30 - dmg;
});
ok('and it is survivable: 100 + coffee 30 - six hits = 10 health left', survivable === 10,
   String(survivable));

// --- Raspberry Reindeer -------------------------------------------------
for (const who of ['pinepenguin', 'polarpear']) {
  const r = await bell({ character: who, points: 120, weather: 'snow', health: 100 });
  ok(`${who} untouched in the snow brings the reindeer in`, r.reindeer === true, JSON.stringify(r));
}
const noSnow = await bell({ character: 'polarpear', points: 120, weather: 'clear', health: 100 });
ok('a clear sky does not', noSnow.reindeer === false, JSON.stringify(noSnow));
const hurt = await bell({ character: 'polarpear', points: 120, weather: 'snow', health: 99 });
ok('nor does 99 health', hurt.reindeer === false, JSON.stringify(hurt));
const wrongHero = await bell({ character: 'badger', points: 120, weather: 'snow', health: 100 });
ok('nor anybody else in the snow', wrongHero.reindeer === false, JSON.stringify(wrongHero));

// --- all three build ----------------------------------------------------
const builds = await page.evaluate(() => {
  const g = window.__game;
  const out = {};
  for (const k of ['error45', 'wagnus', 'reindeer']) {
    g[`${k}Unlocked`] = true;
    g.setCharacter(k);
    out[k] = {
      name: g.player.root.name,
      legs: (g.player.legs || []).length,
      arms: (g.player.arms || []).length,
      allowed: g.isCharacterAllowed(k)
    };
  }
  // Wagnus must be the SAME build as Magnus, not a copy that can drift.
  g.setCharacter('magnus');
  out.magnusStillMagnus = g.player.root.name === 'magnus';
  for (const k of ['error45', 'wagnus', 'reindeer']) {
    g[`${k}Unlocked`] = false;
    localStorage.removeItem(`mystic-badger.${k}Unlocked`);
  }
  return out;
});
for (const k of ['error45', 'wagnus', 'reindeer']) {
  ok(`${k} builds and walks`,
     builds[k].name === k && builds[k].legs === 2 && builds[k].arms === 2 && builds[k].allowed === true,
     JSON.stringify(builds[k]));
}
ok('and Magnus is still Magnus', builds.magnusStillMagnus === true);

// Julie Sweeps The Board was withdrawn after one release. Its id must stay
// in SaveCode's positional vocabulary (removing it would shift every id
// after it) but nothing in the game may award it any more.
const withdrawn = await page.evaluate(async () => {
  const mod = await import('./src/Achievements.js');
  const list = mod.TROPHIES || mod.default.TROPHIES;
  const save = await import('./src/SaveCode.js');
  const vocab = save.VOCAB_TROPHIES || save.default.VOCAB_TROPHIES;
  return {
    gone: list.every((t) => t.id !== 'juliecones'),
    slotKept: vocab.includes('juliecones')
  };
});
ok('Julie Sweeps The Board is gone from the trophy list', withdrawn.gone === true);
ok('but its save-code slot is kept, so old codes still read straight',
   withdrawn.slotKept === true);

console.log('\nCharacter trophies');

// One run, set up however we like, ended at the bell.
const runAs = (o) => page.evaluate((opt) => {
  const g = window.__game;
  for (const f of Object.keys(g).filter((k) => k.endsWith('Unlocked'))) g[f] = true;
  if (g.inMenu) { g.setCharacter(opt.character); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.runUnlockNames = [];
  for (const id of opt.clear || []) g.achievements.delete(id);
  g.points = opt.points === undefined ? 0 : opt.points;
  g.health = opt.health === undefined ? 100 : opt.health;
  g.towerVisits = opt.towerVisits || 0;
  g.stationsVisited = new Set(opt.stations || []);
  g.vehiclesRidden = new Set(opt.vehicles || []);
  if (opt.allStars) { g.spawnedStars = 10; g.starsCollected = 10; }
  else { g.spawnedStars = 10; g.starsCollected = 0; }
  if (opt.guava) g.itemTypesCollected.add(50);
  else g.itemTypesCollected.delete(50);
  if (opt.usage) for (const k of opt.usage) g.charUsage[k] = 1;
  if (opt.dryUsage) for (const k of opt.dryUsage) delete g.charUsage[k];
  if (opt.onWater) {
    const w = g.world;
    g.player.position.set(w.lakeCenterX, w.waterLevel, w.lakeCenterZ);
  } else {
    g.player.position.set(0, 20, 0);
  }
  g.gameOver('time');
  const has = {};
  for (const id of opt.want || []) has[id] = g.achievements.has(id);
  return has;
}, o);

// --- Boffington's Travelcard -------------------------------------------
for (const who of ['boffington', 'boddington']) {
  const r = await runAs({ character: who, clear: ['boffline'], want: ['boffline'],
    stations: ['cave', 'lake', 'copse'] });
  ok(`${who} riding the three original stops earns the Travelcard`,
     r.boffline === true, JSON.stringify(r));
}
const twoStops = await runAs({ character: 'boffington', clear: ['boffline'], want: ['boffline'],
  stations: ['cave', 'lake'] });
ok('two stops is not three', twoStops.boffline === false, JSON.stringify(twoStops));
const withCactus = await runAs({ character: 'boffington', clear: ['boffline'], want: ['boffline'],
  stations: ['cave', 'lake', 'copse', 'cactus'] });
ok('and Cactus Junction on top is fine, not required',
   withCactus.boffline === true, JSON.stringify(withCactus));
const notABoffington = await runAs({ character: 'badger', clear: ['boffline'], want: ['boffline'],
  stations: ['cave', 'lake', 'copse'] });
ok('and it wants a Boffington', notABoffington.boffline === false, JSON.stringify(notABoffington));

// --- Fingers On The Buzzer (awarded mid-run, so drive checkAchievements) --
const buzzer = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.achievements.delete('starbilly');
  g.setCharacter(opt.character);
  g.points = opt.points;
  g.spawnedStars = 10;
  g.starsCollected = opt.stars;
  g.checkAchievements();
  return g.achievements.has('starbilly');
}, o);
for (const who of ['billy', 'ginsberg']) {
  ok(`${who} sweeping the sky on 400 earns the Buzzer`,
     (await buzzer({ character: who, points: 400, stars: 10 })) === true);
}
ok('399 is not 400', (await buzzer({ character: 'billy', points: 399, stars: 10 })) === false);
ok('and a star left up there does not count',
   (await buzzer({ character: 'billy', points: 500, stars: 9 })) === false);
ok('nor does anyone else clearing it',
   (await buzzer({ character: 'badger', points: 500, stars: 10 })) === false);

// --- Nemesis: the cart, and Wagnus ---------------------------------------
const cart = (who) => page.evaluate((k) => {
  const g = window.__game;
  g.achievements.delete('nemesis');
  g.setCharacter(k);
  g.cartHits = 0;
  g.invulnTimer = 0;
  g.health = 100;
  g.isGameOver = false;   // the previous test rang the bell; the cart checks this
  if (!g.cart) return { skipped: true };
  // Drive the cart onto the player's COLLIDER CENTRE, which is what
  // handleHazards measures from — not the position at his feet.
  const c = g.player.getColliderCenter(new (g.player.position.constructor)());
  g.cart.position.set(c.x, c.y, c.z);
  g.handleHazards();
  return { hits: g.cartHits, nemesis: g.achievements.has('nemesis') };
}, who);
const wagnusHit = await cart('wagnus');
ok('the cart finds Wagnus and the grudge is noted',
   wagnusHit.skipped !== true && wagnusHit.hits >= 1 && wagnusHit.nemesis === true,
   JSON.stringify(wagnusHit));
const magnusHit = await cart('magnus');
ok('but Magnus keeps his own grudges', magnusHit.nemesis === false, JSON.stringify(magnusHit));

// --- These Guys Are Pretty Weird ----------------------------------------
const allFour = await runAs({ character: 'postboxer', clear: ['prettyweird'], want: ['prettyweird'],
  usage: ['postboxer', 'edith', 'prunella', 'cardboard'] });
ok('all four weirdos earns it', allFour.prettyweird === true, JSON.stringify(allFour));
const threeOfFour = await runAs({ character: 'postboxer', clear: ['prettyweird'], want: ['prettyweird'],
  usage: ['postboxer', 'edith', 'prunella'], dryUsage: ['cardboard'] });
ok('three of the four does not', threeOfFour.prettyweird === false, JSON.stringify(threeOfFour));

// --- One Hundred And Eighty ---------------------------------------------
const oneEighty = await runAs({ character: 'trifedora', clear: ['fedora180'], want: ['fedora180'],
  points: 180 });
ok('the fedora finishing on 180 on foot earns it', oneEighty.fedora180 === true, JSON.stringify(oneEighty));
const rocketed = await runAs({ character: 'trifedora', clear: ['fedora180'], want: ['fedora180'],
  points: 180, vehicles: ['rocket'] });
ok('the rocket disqualifies it', rocketed.fedora180 === false, JSON.stringify(rocketed));
const flew = await runAs({ character: 'trifedora', clear: ['fedora180'], want: ['fedora180'],
  points: 180, vehicles: ['balloon'] });
ok('but the balloon does not — only the rocket is barred',
   flew.fedora180 === true, JSON.stringify(flew));
const hovered = await runAs({ character: 'trifedora', clear: ['fedora180'], want: ['fedora180'],
  points: 180, vehicles: ['hovercraft'] });
ok('and neither does the hovercraft', hovered.fedora180 === true, JSON.stringify(hovered));
const notQuite = await runAs({ character: 'trifedora', clear: ['fedora180'], want: ['fedora180'],
  points: 181 });
ok('181 is not 180', notQuite.fedora180 === false, JSON.stringify(notQuite));

// --- All The Time In The World -------------------------------------------
const nucleus = await runAs({ character: 'nucleus', clear: ['nucleustime'], want: ['nucleustime'],
  points: 300, towerVisits: 5 });
ok('the Nucleus at five towers on 300 earns it', nucleus.nucleustime === true, JSON.stringify(nucleus));
const fewTowers = await runAs({ character: 'nucleus', clear: ['nucleustime'], want: ['nucleustime'],
  points: 500, towerVisits: 4 });
ok('four towers is not five', fewTowers.nucleustime === false, JSON.stringify(fewTowers));

// --- Laika's Return -------------------------------------------------------
const laika = await runAs({ character: 'julie', clear: ['laika'], want: ['laika'],
  vehicles: ['rocket'], allStars: true, guava: true, points: 300 });
ok("Julie's full flight earns Laika's Return", laika.laika === true, JSON.stringify(laika));
const noGuava = await runAs({ character: 'julie', clear: ['laika'], want: ['laika'],
  vehicles: ['rocket'], allStars: true, guava: false, points: 300 });
ok('without the Guava it does not', noGuava.laika === false, JSON.stringify(noGuava));
const noRocket = await runAs({ character: 'julie', clear: ['laika'], want: ['laika'],
  vehicles: ['balloon'], allStars: true, guava: true, points: 300 });
ok('and the balloon is not a rocket', noRocket.laika === false, JSON.stringify(noRocket));
const ditched = await runAs({ character: 'julie', clear: ['laika'], want: ['laika'],
  vehicles: ['rocket'], allStars: true, guava: true, points: 300, onWater: true });
ok('coming down in the lake is not coming home', ditched.laika === false, JSON.stringify(ditched));

// --- the cave BLT: two new answers from it ------------------------------
const atSandwich = (o) => page.evaluate((opt) => {
  const g = window.__game;
  for (const f of Object.keys(g).filter((k) => k.endsWith('Unlocked'))) g[f] = true;
  if (g.inMenu) { g.beginRun(false, 'easy'); }
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.achievements.delete('parsleyout');
  g.achievements.delete('crisps');
  g.parsleyRejected = false;
  g._crispsClaimed = false;
  g.points = opt.points;
  const sw = g.world.sandwichPos;
  g.player.position.set(sw.x, sw.y, sw.z);
  const said = [];
  const realToast = g.ui.showTimeToast.bind(g.ui);
  g.ui.showTimeToast = (t) => { said.push(t); realToast(t); };
  // handleDoubleTap consumes a real gesture off Input; hand it one.
  const realDouble = g.input.consumeDoubleTap.bind(g.input);
  const realTriple = g.input.consumeTripleTap.bind(g.input);
  g.input.consumeDoubleTap = () => true;
  g.input.consumeTripleTap = () => false;
  g.handleDoubleTap();
  const before = g.points;
  g.handleDoubleTap();          // a second visit must not pay twice
  g.input.consumeDoubleTap = realDouble;
  g.input.consumeTripleTap = realTriple;
  g.ui.showTimeToast = realToast;
  return {
    said,
    points: g.points,
    paidTwice: g.points !== before,
    parsleyout: g.achievements.has('parsleyout'),
    crisps: g.achievements.has('crisps')
  };
}, o);

const parsley500 = await atSandwich({ character: 'parsley', points: 500 });
ok('Parsley on 500 is shown the door',
   parsley500.parsleyout === true
   && parsley500.said.some((t) => /Get that Parsley out of here/i.test(t)),
   JSON.stringify(parsley500.said));
const parsley499 = await atSandwich({ character: 'parsley', points: 499 });
ok('on 499 the sandwich is merely dry',
   parsley499.parsleyout === false
   && parsley499.said.some((t) => /TOO DRY/i.test(t)), JSON.stringify(parsley499.said));

const hughes400 = await atSandwich({ character: 'hughes', points: 400 });
ok('Hughes on 400 gets his crisps and his +40',
   hughes400.crisps === true && hughes400.points === 440
   && hughes400.said.some((t) => /Everything is better with crisps/i.test(t)),
   JSON.stringify(hughes400));
ok('and the +40 is once per run, not once per tap', hughes400.paidTwice === false,
   JSON.stringify(hughes400));
const hughes399 = await atSandwich({ character: 'hughes', points: 399 });
ok('on 399 he gets nothing', hughes399.crisps === false && hughes399.points === 399,
   JSON.stringify(hughes399));

// --- McDonovan's usual ---------------------------------------------------
const coffeeAs = (o) => page.evaluate((k) => {
  const g = window.__game;
  g.achievements.delete('mcdcoffee');
  g.setCharacter(k.who);
  g.coffeeDrunk = false;
  g.health = k.health === undefined ? 50 : k.health;
  const w = g.world;
  g.handleCoffee({ x: w.coffeeX, y: w.coffeeLevel, z: w.coffeeZ });
  return { drunk: g.coffeeDrunk, health: g.health, earned: g.achievements.has('mcdcoffee') };
}, o);
const mcd = await coffeeAs({ who: 'mcdonovan', health: 50 });
ok('McDonovan taking the +30 gets the trophy',
   mcd.drunk === true && mcd.health === 80 && mcd.earned === true, JSON.stringify(mcd));
// The trophy is for TAKING the health, so a full-health sip must not count.
const mcdFull = await coffeeAs({ who: 'mcdonovan', health: 100 });
ok('but sipping it on full health does not', mcdFull.earned === false, JSON.stringify(mcdFull));
const otherDrinker = await coffeeAs({ who: 'badger', health: 50 });
ok('and anyone else just gets a coffee', otherDrinker.earned === false, JSON.stringify(otherDrinker));

// --- Twice The Pickle ----------------------------------------------------
const doublePickle = (mult) => page.evaluate((m) => {
  const g = window.__game;
  g.achievements.delete('taradouble');
  g.setCharacter('tapir');
  g.pickleMultiplier = m;
  g.picklesCollected = 0;
  // Put a pickle on top of her and run the collector.
  const c = g.player.getColliderCenter(new (g.player.position.constructor)());
  const pickle = g.collectibles.find((i) => i.value === 8.8);
  if (!pickle) return { skipped: true };
  pickle.state = 'idle';
  pickle.group.position.set(c.x, c.y, c.z);
  g.handlePickups();
  return { picked: g.picklesCollected, earned: g.achievements.has('taradouble') };
}, mult);
const withDeal = await doublePickle(2);
const withoutDeal = await doublePickle(1);
if (withDeal.skipped || withoutDeal.skipped) {
  ok('a pickle was available to test with', false, 'no pickle in the item list');
} else {
  ok('a pickle taken while the deal runs earns Twice The Pickle',
     withDeal.earned === true, JSON.stringify(withDeal));
  ok('and one taken before it does not', withoutDeal.earned === false, JSON.stringify(withoutDeal));
}

// --- Told You So: five bad spins, counted whether or not consecutive ------
const spins = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.achievements.delete('nellyfive');
  g.setCharacter(opt.character);
  g._whirlNegRun = 0;
  g._whirlNegStreak = 0;
  g._whirlPosStreak = 0;
  const w = g.world;
  for (const sign of opt.pattern) {
    g._inWhirl = false;
    g.isGameOver = false;
    g.inMenu = false;
    // Force the spin's sign by pinning Math.random for that one dip.
    const real = Math.random;
    Math.random = () => (sign < 0 ? 0.05 : 0.95);
    g.player.position.set(w.whirlX, w.whirlWaterLevel, w.whirlZ);
    g.tick();
    Math.random = real;
  }
  return { negatives: g._whirlNegRun, earned: g.achievements.has('nellyfive') };
}, o);
const threeBad = await spins({ character: 'nelly', pattern: [-1, -1, -1] });
ok('Nelly on three bad spins in a row is proved right', threeBad.earned === true,
   JSON.stringify(threeBad));
const twoBad = await spins({ character: 'nelly', pattern: [-1, -1] });
ok('two is not three', twoBad.earned === false, JSON.stringify(twoBad));
// The run of three must be UNBROKEN — a good spin in the middle resets it.
const brokenUp = await spins({ character: 'nelly', pattern: [-1, -1, 1, -1, -1] });
ok('and a good spin in the middle breaks the run', brokenUp.earned === false,
   JSON.stringify(brokenUp));
const thenThree = await spins({ character: 'nelly', pattern: [-1, -1, 1, -1, -1, -1] });
ok('but three after the break still counts', thenThree.earned === true,
   JSON.stringify(thenThree));
const notNelly = await spins({ character: 'badger', pattern: [-1, -1, -1] });
ok('and it is hers alone', notNelly.earned === false, JSON.stringify(notNelly));

// --- Gary Takes The Air ---------------------------------------------------
const summit = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.achievements.delete('garyair');
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.inMenu = false;
  g._onSummit = false;
  const w = g.world;
  const y = w.getHeight(w.mountainX, w.mountainZ);
  g.player.position.set(w.mountainX, y, w.mountainZ);
  // Seconds of "just flew in" still on the clock. 0 means he climbed it.
  g._skyGrace = opt.grace;
  g.tick();
  return g.achievements.has('garyair');
}, o);
const flownIn = await summit({ character: 'gary', grace: 5 });
ok('Gary arriving a second after a sky ride earns it', flownIn === true);
const climbedIt = await summit({ character: 'gary', grace: 0 });
ok('Gary who walked up gets nothing', climbedIt === false);
const longAgo = await summit({ character: 'gary', grace: 0 });
ok('and a ride whose grace has run out does not count', longAgo === false);
const notGary = await summit({ character: 'badger', grace: 5 });
ok('nor does anyone else flying in', notGary === false);

// --- Florence Goes Round Again -------------------------------------------
const helter = (who) => page.evaluate((k) => {
  const g = window.__game;
  g.achievements.delete('candyslide');
  g.setCharacter(k);
  g.isGameOver = false;
  g.inMenu = false;
  g._onHelter = false;
  const w = g.world;
  g.player.position.set(w.helterX, w.getHeight(w.helterX, w.helterZ), w.helterZ);
  g.player.grounded = true;
  g.tick();
  return { earned: g.achievements.has('candyslide'), flung: g.player.grounded === false };
}, who);
const candyRide = await helter('candy');
ok('Candy beside the helter skelter is flung, and it counts as a ride',
   candyRide.earned === true && candyRide.flung === true, JSON.stringify(candyRide));
const notCandy = await helter('badger');
ok('anyone else just stands there', notCandy.earned === false, JSON.stringify(notCandy));

// --- the nine newest -----------------------------------------------------
// runAs already ends a run however we like; extend it for the new inputs.
const bellNew = (o) => page.evaluate((opt) => {
  const g = window.__game;
  for (const f of Object.keys(g).filter((k) => k.endsWith('Unlocked'))) g[f] = true;
  if (g.inMenu) { g.setCharacter(opt.character); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.runUnlockNames = [];
  for (const id of opt.clear || []) g.achievements.delete(id);
  g.points = opt.points === undefined ? 0 : opt.points;
  g.health = opt.health === undefined ? 100 : opt.health;
  g.weather.set(opt.weather || 'clear');
  g.applyWolk(opt.weather || 'clear');
  g.enteredNook = Boolean(opt.nook);
  g.towerTouched = Boolean(opt.tower);
  g.player.position.set(0, 20, 0);
  g.gameOver(opt.reason || 'time');
  const has = {};
  for (const id of opt.want || []) has[id] = g.achievements.has(id);
  return has;
}, o);

// Night Vision
for (const kind of ['fog', 'haze', 'storm']) {
  const r = await bellNew({ character: 'nighteye', clear: ['nightvision'], want: ['nightvision'],
    points: 400, weather: kind });
  ok(`Night Eye on 400 in ${kind} sees through it`, r.nightvision === true, JSON.stringify(r));
}
const clearNight = await bellNew({ character: 'nighteye', clear: ['nightvision'], want: ['nightvision'],
  points: 500, weather: 'clear' });
ok('a clear evening asks nothing of him', clearNight.nightvision === false, JSON.stringify(clearNight));
const dimNight = await bellNew({ character: 'nighteye', clear: ['nightvision'], want: ['nightvision'],
  points: 399, weather: 'fog' });
ok('and 399 is not 400', dimNight.nightvision === false, JSON.stringify(dimNight));

// Tudor Rose
const round300 = await bellNew({ character: 'tudor', clear: ['tudorround'], want: ['tudorround'],
  points: 300 });
ok('Tudor on a round hundred takes the Rose', round300.tudorround === true, JSON.stringify(round300));
const notRound = await bellNew({ character: 'tudor', clear: ['tudorround'], want: ['tudorround'],
  points: 301 });
ok('301 is not round', notRound.tudorround === false, JSON.stringify(notRound));
const zero = await bellNew({ character: 'tudor', clear: ['tudorround'], want: ['tudorround'],
  points: 0 });
ok('and nought does not count as a round hundred', zero.tudorround === false, JSON.stringify(zero));

// 400 Bad Request
const err400 = await bellNew({ character: 'error45', clear: ['badrequest'], want: ['badrequest'],
  points: 400 });
ok('Error #45 on 400 answers the family bar', err400.badrequest === true, JSON.stringify(err400));
const err399 = await bellNew({ character: 'error45', clear: ['badrequest'], want: ['badrequest'],
  points: 399 });
ok('399 does not', err399.badrequest === false, JSON.stringify(err399));

// Live Wire
const wired = await bellNew({ character: 'electro', clear: ['livewire'], want: ['livewire'],
  points: 300, weather: 'storm', tower: true });
ok('Electro Badger surviving the live pylon on 300 is a Live Wire',
   wired.livewire === true, JSON.stringify(wired));
const noPylon = await bellNew({ character: 'electro', clear: ['livewire'], want: ['livewire'],
  points: 500, weather: 'storm', tower: false });
ok('without touching the tower it does not fire', noPylon.livewire === false, JSON.stringify(noPylon));
const noStorm = await bellNew({ character: 'electro', clear: ['livewire'], want: ['livewire'],
  points: 500, weather: 'clear', tower: true });
ok('and the pylon is only live in a storm', noStorm.livewire === false, JSON.stringify(noStorm));
const fried = await bellNew({ character: 'electro', clear: ['livewire'], want: ['livewire'],
  points: 500, weather: 'storm', tower: true, health: 0, reason: 'health' });
ok('you have to survive it', fried.livewire === false, JSON.stringify(fried));

// Third Class Post
const post303 = await bellNew({ character: 'postboxer', clear: ['thirdclass'], want: ['thirdclass'],
  points: 303 });
ok('Postboxer above 300 on a multiple of 3 posts third class',
   post303.thirdclass === true, JSON.stringify(post303));
const post300 = await bellNew({ character: 'postboxer', clear: ['thirdclass'], want: ['thirdclass'],
  points: 300 });
ok('exactly 300 is not ABOVE 300', post300.thirdclass === false, JSON.stringify(post300));
const post301 = await bellNew({ character: 'postboxer', clear: ['thirdclass'], want: ['thirdclass'],
  points: 301 });
ok('and 301 does not divide by three', post301.thirdclass === false, JSON.stringify(post301));

// Raspberry Blue Rain
const rained = await bellNew({ character: 'reindeer', clear: ['blueberryrain'], want: ['blueberryrain'],
  weather: 'rain', nook: true, points: 100 });
ok('the reindeer in the rain, having been in the Nook, earns it',
   rained.blueberryrain === true, JSON.stringify(rained));
const noShelter = await bellNew({ character: 'reindeer', clear: ['blueberryrain'], want: ['blueberryrain'],
  weather: 'rain', nook: false, points: 100 });
ok('without the Nook it does not', noShelter.blueberryrain === false, JSON.stringify(noShelter));
const dryRun = await bellNew({ character: 'reindeer', clear: ['blueberryrain'], want: ['blueberryrain'],
  weather: 'clear', nook: true, points: 100 });
ok('and it has to actually be raining', dryRun.blueberryrain === false, JSON.stringify(dryRun));

// isInsideNook is the real gate for that flag, and it is shared with the
// dollhouse roof — so check it agrees about the Nook's own doorstep.
const nookGeometry = await page.evaluate(() => {
  const g = window.__game;
  const w = g.world;
  return {
    inside: w.isInsideNook(w.neptuneX, w.neptuneLevel + 1, w.neptuneZ),
    farOff: w.isInsideNook(w.neptuneX + 40, w.neptuneLevel + 1, w.neptuneZ),
    highAbove: w.isInsideNook(w.neptuneX, w.neptuneLevel + 40, w.neptuneZ)
  };
});
ok('isInsideNook knows the inside from the outside',
   nookGeometry.inside === true && nookGeometry.farOff === false
   && nookGeometry.highAbove === false, JSON.stringify(nookGeometry));

// Cactus Balloon Balloon — a pickup taken while actually aboard
const balloonGrab = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.achievements.delete('cactusair');
  g.setCharacter(opt.character);
  g.balloonPickup = false;
  // Pretend to be in the basket (or not).
  g.player.vehicle = opt.aboard ? { kind: opt.kind } : null;
  const c = g.player.getColliderCenter(new (g.player.position.constructor)());
  const item = g.collectibles.find((i) => i.state === 'idle') || g.collectibles[0];
  if (!item) return { skipped: true };
  item.state = 'idle';
  item.group.position.set(c.x, c.y, c.z);
  g.handlePickups();
  g.player.vehicle = null;
  return { earned: g.achievements.has('cactusair'), flag: g.balloonPickup };
}, o);
const inBasket = await balloonGrab({ character: 'cactusballoon', aboard: true, kind: 'balloon' });
ok('Cactus Balloon collecting from the basket earns Cactus Balloon Balloon',
   inBasket.earned === true, JSON.stringify(inBasket));
const onFoot = await balloonGrab({ character: 'cactusballoon', aboard: false });
ok('the same pickup on foot does not', onFoot.earned === false, JSON.stringify(onFoot));
const inRocket = await balloonGrab({ character: 'cactusballoon', aboard: true, kind: 'rocket' });
ok('and the rocket is not a balloon', inRocket.earned === false, JSON.stringify(inRocket));

// Meet Your Maker — either order
const maker = (o) => page.evaluate((opt) => {
  const g = window.__game;
  g.achievements.delete('meetmaker');
  g.setCharacter(opt.character);
  g.isGameOver = false;
  g.raisinTaken = false;
  g.touchedStove = false;
  g.muffinAblaze = false;
  g.health = 100;
  const st = g.world.cottage.stove;
  const touchStove = () => {
    g.player.position.set(st.x, st.y, st.z);
    g.handleCottage();
  };
  const takeRaisin = () => {
    const w = g.world;
    w.resetRaisin();
    if (w.neptuneRaisin) w.neptuneRaisin.visible = true;
    const rp = w.neptuneRaisinPos;
    g.player.position.set(rp.x, rp.y, rp.z);
    g.tick();
  };
  if (opt.order === 'stove-first') { touchStove(); takeRaisin(); }
  else { takeRaisin(); touchStove(); }
  return { earned: g.achievements.has('meetmaker'), raisin: g.raisinTaken, stove: g.touchedStove };
}, o);
const raisinFirst = await maker({ character: 'muffin', order: 'raisin-first' });
ok('the muffin, raisin then oven, meets his maker', raisinFirst.earned === true,
   JSON.stringify(raisinFirst));
const stoveFirst = await maker({ character: 'muffin', order: 'stove-first' });
ok('and the other way round works too — order must not matter',
   stoveFirst.earned === true, JSON.stringify(stoveFirst));
const notMuffin = await maker({ character: 'badger', order: 'raisin-first' });
ok('nobody else has a maker to meet', notMuffin.earned === false, JSON.stringify(notMuffin));

console.log('\nPhantom Badger');

// Unlocked by any badger seeing a monochrome run out to the bell.
const mysticRunAs = (who) => page.evaluate((k) => {
  const g = window.__game;
  g.phantomUnlocked = false;
  localStorage.removeItem('mystic-badger.phantomUnlocked');
  for (const f of Object.keys(g).filter((x) => x.endsWith('Unlocked') && x !== 'phantomUnlocked')) {
    g[f] = true;
  }
  if (g.inMenu) { g.setCharacter(k); g.beginRun(false, 'easy'); }
  else { g.restart(false, 'easy'); }
  g.setCharacter(k);
  g.isGameOver = false;
  g.runUnlockNames = [];
  g.setMystic(true);              // this run was run in monochrome
  g.points = 100;
  g.gameOver('time');
  return {
    unlocked: g.phantomUnlocked,
    stored: localStorage.getItem('mystic-badger.phantomUnlocked'),
    named: g.runUnlockNames.includes('Phantom Badger')
  };
}, who);
for (const who of ['badger', 'william', 'electro', 'vapour']) {
  const r = await mysticRunAs(who);
  ok(`${who} completing a Mystic run raises the Phantom`,
     r.unlocked === true && r.stored === '1' && r.named === true, JSON.stringify(r));
}
const notABadger = await mysticRunAs('tapir');
ok('a Mystic run by somebody who is not a badger does not',
   notABadger.unlocked === false, JSON.stringify(notABadger));
const plainRun = await page.evaluate(() => {
  const g = window.__game;
  g.phantomUnlocked = false;
  localStorage.removeItem('mystic-badger.phantomUnlocked');
  g.restart(false, 'easy');
  g.setCharacter('badger');
  g.isGameOver = false;
  g.setMystic(false);
  g.points = 500;
  g.gameOver('time');
  return g.phantomUnlocked;
});
ok('and an ordinary badger run does not either', plainRun === false);

// He builds, he is a badger, and he is see-through.
const phantom = await page.evaluate(() => {
  const g = window.__game;
  g.phantomUnlocked = true;
  g.setCharacter('phantom');
  // The haze shells are the only transparent thing on him, and they must be
  // BackSide + depthWrite:false — that is what keeps them outside the body
  // instead of x-raying his own nested shells.
  let haze = 0;
  let coloured = 0;
  let neutral = 0;
  g.player.root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (m.transparent && m.opacity < 1) {
      if (m.depthWrite === false) haze += 1;
      return;
    }
    // Greyscale means R, G and B within a hair of each other.
    const c = m.color;
    const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    if (spread > 0.08) coloured += 1; else neutral += 1;
  });
  return {
    name: g.player.root.name,
    isBadger: !!g.player.isBadger,
    legs: (g.player.legs || []).length,
    allowed: g.isCharacterAllowed('phantom'),
    haze, coloured, neutral,
    vertexColours: (() => {
      let vc = 0;
      g.player.root.traverse((o) => { if (o.material && o.material.vertexColors) vc += 1; });
      return vc;
    })()
  };
});
ok('the Phantom builds, walks, and counts as a badger',
   phantom.name === 'phantom' && phantom.isBadger === true && phantom.legs === 4
   && phantom.allowed === true, JSON.stringify(phantom));
ok('he is drained to greyscale — nothing on him carries a hue',
   phantom.coloured === 0 && phantom.neutral > 4, JSON.stringify(phantom));
// The badger's painted saddle and warm cream face would leak straight
// through a vertex-coloured material, so they must be switched off for him.
ok('and his vertex colours are switched off', phantom.vertexColours === 0,
   JSON.stringify(phantom));
ok('with a haze hung outside the body', phantom.haze >= 3, JSON.stringify(phantom));

// The static. Declared on the materials, and — the part that matters —
// actually MOVING: a shader effect that compiles but never changes is
// indistinguishable from a texture, and a still screenshot cannot tell them
// apart. So render the same view at two clock values and count the pixels
// that differ.
const staticEffect = await page.evaluate(async () => {
  const g = window.__game;
  const shaders = await import('./src/Shaders.js');
  g.phantomUnlocked = true;
  g.setCharacter('phantom');
  g.setMystic(false);
  let declared = 0;
  g.player.root.traverse((o) => {
    if (o.material && o.material.defines && 'USE_STATIC' in o.material.defines) declared += 1;
  });

  // Frame him, then render twice with the shared clock moved on.
  g.renderer.setAnimationLoop(null);
  const root = g.player.root;
  root.position.set(0, 0, 0); root.rotation.set(0, 0.7, 0); root.updateMatrixWorld(true);
  const cam = g.camera;
  cam.position.set(0, 1.4, 3.4); cam.lookAt(0, 0.75, 0);
  // Read back only the CENTRAL BOX of the frame. The camera is framed on the
  // character, so that box is nearly all him — sampling the whole buffer
  // measures mostly world, which sways on the same clock and drowns the
  // signal out.
  const gl = g.renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const bw = Math.floor(W * 0.34), bh = Math.floor(H * 0.34);
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2);
  const grab = (t) => {
    shaders.SharedUniforms.uTime.value = t;
    g.renderer.render(g.scene, cam);
    const buf = new Uint8Array(bw * bh * 4);
    gl.readPixels(bx, by, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  const churn = () => {
    const a = grab(10.0);
    const b = grab(10.4);        // several static ticks later
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 6) differing += 1;
    return differing / (a.length / 4);
  };
  const moved = churn();

  // …and the control: the same box, same scene, a hero with no static in him.
  g.setCharacter('badger');
  root.position.set(0, 0, 0); root.rotation.set(0, 0.7, 0); root.updateMatrixWorld(true);
  const control = churn();
  return { declared, moved, control, box: [bw, bh] };
});
ok('the static is declared on his materials', staticEffect.declared >= 3,
   JSON.stringify(staticEffect));
ok('and it actually moves between frames', staticEffect.moved > 0.02,
   `only ${(staticEffect.moved * 100).toFixed(2)}% of pixels changed`);
// The control is NOT zero and should not be expected to be: the world runs
// on the same clock, so grass sways and pine cones pulse between the two
// renders whoever is standing there. What matters is that the Phantom moves
// a great deal more than the same scene does without him.
ok(`and far more than the same scene does without him (x${(staticEffect.moved / Math.max(staticEffect.control, 1e-6)).toFixed(1)})`,
   staticEffect.moved > staticEffect.control * 5,
   `phantom ${(staticEffect.moved * 100).toFixed(2)}% vs control ${(staticEffect.control * 100).toFixed(2)}%`);

// The odds: ten times everyone else's, and rolled even when he is CHOSEN
// rather than drawn — the wash used to be a side effect of the random draw
// alone, so a deliberately picked Phantom would never have rolled at all.
const odds = await page.evaluate(() => {
  const g = window.__game;
  const measure = (character, n) => {
    let hits = 0;
    for (let i = 0; i < n; i++) if (g.rollMystic(character)) hits += 1;
    return hits / n;
  };
  const N = 40000;
  return { phantom: measure('phantom', N), badger: measure('badger', N) };
});
ok('the Phantom draws Mystic about 18% of the time',
   Math.abs(odds.phantom - 0.18) < 0.012, JSON.stringify(odds));
ok('and everyone else stays rare', odds.badger < 0.035, JSON.stringify(odds));

const chosenNotDrawn = await page.evaluate(() => {
  const g = window.__game;
  g.phantomUnlocked = true;
  g.restart(false, 'easy');
  g.ui._selectedCharacter = 'phantom';   // deliberately picked, not random
  const real = Math.random;
  Math.random = () => 0.01;              // under 0.14, so the wash must land
  g.restart(false, 'easy');
  const out = { who: g.characterName, mystic: g.mysticRun };
  Math.random = real;
  return out;
});
ok('a deliberately chosen Phantom still rolls his wash',
   chosenNotDrawn.who === 'phantom' && chosenNotDrawn.mystic === true,
   JSON.stringify(chosenNotDrawn));
await page.evaluate(() => {
  const g = window.__game;
  g.setMystic(false);
  g.ui._selectedCharacter = null;
  g.phantomUnlocked = false;
  localStorage.removeItem('mystic-badger.phantomUnlocked');
});

await page.evaluate(() => {
  const g = window.__game;
  g.muffinUnlocked = false;
  g.raisinsAllTime = 0;
  localStorage.removeItem('mystic-badger.muffinUnlocked');
  localStorage.removeItem('mystic-badger.raisinsAllTime');
});


const tierAt = (count) => page.evaluate((n) => {
  const g = window.__game;
  // Field names do not all match roster keys, so read the real ones off the
  // object rather than deriving them.
  const flags = Object.keys(g).filter((k) => k.endsWith('Unlocked'));
  for (const f of flags) g[f] = false;
  flags.slice(0, n).forEach((f) => { g[f] = true; });
  for (const id of ['unlock1', 'unlock5', 'unlock10', 'unlock20', 'unlock50']) g.achievements.delete(id);
  g.checkAchievements();
  return {
    n: g.unlockedCharacterCount(),
    got: ['unlock1', 'unlock5', 'unlock10', 'unlock20', 'unlock50'].filter((i) => g.achievements.has(i))
  };
}, count);
for (const [count, want] of [[4, 1], [5, 2], [10, 3], [20, 4], [50, 5]]) {
  const r = await tierAt(count);
  ok(`${r.n} unlocked earns ${want} tier(s)`, r.got.length === want, JSON.stringify(r));
}
const ceiling = await page.evaluate(() => {
  const g = window.__game;
  const flags = Object.keys(g).filter((k) => k.endsWith('Unlocked'));
  for (const f of flags) g[f] = true;
  const max = g.unlockedCharacterCount();
  for (const f of flags) g[f] = false;
  return max;
});
// Heaven's Door asks for 50 — worth knowing the roster can actually get there.
ok(`50 is reachable (the roster tops out at ${ceiling})`, ceiling >= 50, String(ceiling));

const rollWith = (keys) => page.evaluate((ks) => {
  const g = window.__game;
  for (const f of Object.keys(g).filter((k) => k.endsWith('Unlocked'))) g[f] = false;
  for (const k of ks) if (`${k}Unlocked` in g) g[`${k}Unlocked`] = true;
  g.achievements.delete('unlockroll');
  g.checkAchievements();
  return g.achievements.has('unlockroll');
}, keys);
ok("Unlock 'N' Roll: walkers alone do not earn it", await rollWith(['tudor', 'electro', 'jam']) === false);
for (const k of ['marblella', 'foil', 'snappy']) {
  ok(`Unlock 'N' Roll: ${k} earns it`, await rollWith([k]) === true);
}
// The constant is a lookup for speed; Player.rollsOrSlides is the authority.
// If they ever disagree the trophy silently stops meaning what it says.
const rollers = await page.evaluate(async () => {
  const g = window.__game;
  const mod = await import('./src/Achievements.js');
  const keys = (mod.CHARACTER_UNLOCKS || mod.default.CHARACTER_UNLOCKS).map((c) => c.key);
  const found = [];
  for (const k of keys) { g.setCharacter(k); if (g.player.rollsOrSlides) found.push(k); }
  return found.sort();
});
ok('the roller list matches who actually rolls or slides',
   JSON.stringify(rollers) === JSON.stringify(['foil', 'marblella', 'snappy']), JSON.stringify(rollers));

/* == 10. save & restore, end to end ===================================== */
console.log('\nSave & Restore');
await page.evaluate(() => {
  localStorage.clear();
  const S = 'mystic-badger.';
  localStorage.setItem(S + 'electroUnlocked', '1');
  localStorage.setItem(S + 'williamUnlocked', '1');
  localStorage.setItem(S + 'highScore', '106.6');
  localStorage.setItem(S + 'totalScore', '54321.55');
  localStorage.setItem(S + 'achievements', 'score50,hastings,zapped,antizapped');
  localStorage.setItem(S + 'charUsage', JSON.stringify({ badger: 31, william: 7 }));
  localStorage.setItem(S + 'character', 'electro');
});
await page.reload();
await ready();

await page.click('#menu-save-btn');
await page.waitForSelector('#save-panel:not(.hidden)', { timeout: 10000 });
const code = await page.inputValue('#save-code');
ok('the panel produces a code', code.length > 20, code);

// Wipe it the way a browser would, then paste the code back.
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();
ok('wiping really wipes it', await page.evaluate(() => window.__game.isCharacterAllowed('electro')) === false);

await page.click('#menu-save-btn');
await page.waitForSelector('#save-panel:not(.hidden)', { timeout: 10000 });
await page.fill('#save-restore-input', code);
await page.click('#save-restore');
await page.waitForTimeout(1800);
await ready();

const back = await page.evaluate(() => {
  const g = window.__game;
  return {
    electro: g.isCharacterAllowed('electro'), william: g.isCharacterAllowed('william'),
    high: g.highScore, total: g.totalScore, character: g.characterName,
    usage: JSON.stringify(g.charUsage),
    seeded: ['score50', 'hastings', 'zapped', 'antizapped'].every((t) => g.achievements.has(t))
  };
});
ok('unlocks come back', back.electro && back.william);
// Retroactive milestones mean the trophy COUNT grows on load (lifetime score
// credits lifetime10k etc.) — so assert the seeded ones survived, not the total.
ok('every seeded trophy survives', back.seeded === true);
ok('the high score comes back exactly', back.high === 106.6, String(back.high));
ok('the lifetime score comes back exactly', back.total === 54321.55, String(back.total));
ok('character usage comes back', back.usage === JSON.stringify({ badger: 31, william: 7 }), back.usage);
ok('the selected hero comes back', back.character === 'electro', back.character);

// A typo must leave the existing save alone.
const typo = code.slice(0, 8) + (code[8] === 'Z' ? 'Y' : 'Z') + code.slice(9);
await page.click('#menu-save-btn');
await page.waitForSelector('#save-panel:not(.hidden)', { timeout: 10000 });
await page.fill('#save-restore-input', typo);
await page.click('#save-restore');
await page.waitForTimeout(500);
ok('a typo is refused', /typo|could not|newer|short/i.test(await page.textContent('#save-status')));
ok('and the save is untouched', await page.evaluate(() => window.__game.isCharacterAllowed('electro')) === true);

// A code must carry a save into a browser that has never seen this game.
// The first page is done with — close it, or two software-rendered WebGL
// contexts compete and the fresh one times out loading.
await page.close();
const page2 = await (await browser.newContext()).newPage();
await page2.goto(URL_ARG, { timeout: 60000 });
await ready(page2);
ok('a clean browser starts locked',
   await page2.evaluate(() => window.__game.isCharacterAllowed('electro')) === false);
await page2.click('#menu-save-btn');
await page2.waitForSelector('#save-panel:not(.hidden)', { timeout: 10000 });
await page2.fill('#save-restore-input', code);
await page2.click('#save-restore');
await page2.waitForTimeout(1800);
await ready(page2);
const other = await page2.evaluate(() => ({
  electro: window.__game.isCharacterAllowed('electro'), high: window.__game.highScore
}));
ok('the code carries the save to another browser', other.electro === true && other.high === 106.6,
   JSON.stringify(other));

if (errs.length) { fail++; console.log(`  ✗ page errors: ${errs.join(' | ')}`); }
await browser.close();
console.log(`\n${fail === 0 ? '✅ browser: ALL PASS' : `‼️  browser: ${fail} FAILURE(S)`} (${pass} checks)`);
process.exit(fail ? 1 : 0);
