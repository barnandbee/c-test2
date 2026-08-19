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
  'badger', 'badgerette', 'william', 'glassbadger', 'vapour', 'spirit', 'electro'
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

/* == 6. save & restore, end to end ====================================== */
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
