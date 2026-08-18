/**
 * Save-code codec tests. Pure node — no browser, no dependencies.
 *
 *   node tests/savecode.test.mjs
 *
 * The codec is the one part of the game where a bug is silently destructive:
 * a save that encodes wrong, or a damaged code that decodes to something
 * plausible, loses a player's progress with no way back. So this leans on
 * randomised round-trips and deliberate corruption rather than a few examples.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  encode, decode, readSave, writeSave, describe,
  SCHEMA_BOOLS, SCHEMA_INTS, SCHEMA_FLOATS, SCHEMA_CHAR_SETS,
  VOCAB_TROPHIES, VOCAB_CHARACTERS
} from '../src/SaveCode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;

/**
 * A save is an unordered bag of keys, and its sets are Sets — so neither key
 * order nor member order carries meaning. Compare on that basis, or the test
 * ends up asserting the codec's choice of ordering instead of whether it
 * preserved anything.
 */
const SET_KEYS = new Set(['achievements', 'scored100', 'scored200', 'scored300', 'sandwichDressers']);
const normalise = (save) => {
  const out = {};
  for (const k of Object.keys(save).sort()) {
    let v = save[k];
    if (SET_KEYS.has(k)) v = String(v).split(',').filter(Boolean).sort().join(',');
    else if (k === 'charUsage') {
      try { v = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(v)).sort())); } catch { /* keep raw */ }
    }
    out[k] = v;
  }
  return out;
};
const eq = (name, a, b) => {
  const A = JSON.stringify(normalise(a)), B = JSON.stringify(normalise(b));
  if (A === B) { pass++; return true; }
  fail++;
  console.log(`FAIL  ${name}\n  got      ${A}\n  expected ${B}`);
  return false;
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  fail++;
  console.log(`FAIL  ${name} ${detail}`);
  return false;
};
const roundTrip = (name, save) => eq(name, decode(encode(save)), save);

/* -- 1. the shapes a save can take ------------------------------------- */
roundTrip('empty save', {});

const mid = {
  badgeretteUnlocked: '1', williamUnlocked: '1', electroUnlocked: '1', muted: '1',
  frogHitsAllTime: '57', summitVisits: '3',
  highScore: '106.6', totalScore: '12345.67',
  achievements: 'score50,score100,zapped,antizapped,hastings',
  scored100: 'badger,william', sandwichDressers: 'mayo,jam',
  character: 'electro',
  charUsage: JSON.stringify({ badger: 40, william: 12, electro: 3 })
};
roundTrip('mid-game save', mid);

const full = {};
for (const k of SCHEMA_BOOLS) full[k] = '1';
for (const k of SCHEMA_INTS) full[k] = '99999';
full.highScore = '987.65432';
full.totalScore = '1234567.89';
full.achievements = VOCAB_TROPHIES.join(',');
for (const k of SCHEMA_CHAR_SETS) full[k] = VOCAB_CHARACTERS.join(',');
full.character = 'badger';
full.charUsage = JSON.stringify(Object.fromEntries(VOCAB_CHARACTERS.map((c, i) => [c, i + 1])));
roundTrip('maxed save', full);

/* -- 2. decimals survive to the last digit ----------------------------- */
// 106.6 unlocks a trophy by exact comparison; a float round-trip that turns it
// into 106.59999999999999 would quietly make that trophy unearnable.
for (const v of ['106.6', '63.14159', '0.1', '1e3', '45.45', '-12.5', '100', '0.01']) {
  eq(`score "${v}" survives verbatim`, decode(encode({ highScore: v })).highScore, v);
}

/* -- 3. nothing is silently dropped ------------------------------------ */
// The schema will always lag the game eventually. When it does, the unknown
// thing must ride along rather than vanish.
roundTrip('unknown future keys', { someFutureKey: 'hello', anotherOne: '42', electroUnlocked: '1' });
roundTrip('unknown trophy id', { achievements: 'zapped,notyetinvented' });
roundTrip('unknown character in a set', { scored100: 'badger,futurehero' });
roundTrip('unknown selected character', { character: 'futurehero' });
roundTrip('unknown character usage', { charUsage: JSON.stringify({ badger: 5, futurehero: 2 }) });

/* -- 4. randomised saves ----------------------------------------------- */
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
let randomFails = 0;
for (let n = 0; n < 500; n++) {
  const s = {};
  for (const k of SCHEMA_BOOLS) if (rnd() < 0.5) s[k] = '1';
  for (const k of SCHEMA_INTS) if (rnd() < 0.6) s[k] = String(Math.floor(rnd() * 200000));
  if (rnd() < 0.8) s.highScore = String(Math.floor(rnd() * 100000) / 100);
  if (rnd() < 0.8) s.totalScore = String(Math.floor(rnd() * 10000000) / 100);
  const tr = VOCAB_TROPHIES.filter(() => rnd() < 0.5);
  if (tr.length) s.achievements = tr.join(',');
  for (const k of SCHEMA_CHAR_SETS) {
    const m = VOCAB_CHARACTERS.filter(() => rnd() < 0.3);
    if (m.length) s[k] = m.join(',');
  }
  if (rnd() < 0.9) s.character = VOCAB_CHARACTERS[Math.floor(rnd() * VOCAB_CHARACTERS.length)];
  const u = {};
  for (const c of VOCAB_CHARACTERS) if (rnd() < 0.25) u[c] = Math.floor(rnd() * 500) + 1;
  if (Object.keys(u).length) s.charUsage = JSON.stringify(u);
  const got = decode(encode(s));
  if (JSON.stringify(normalise(got)) !== JSON.stringify(normalise(s))) {
    randomFails++;
    if (randomFails === 1) {
      console.log('FAIL  random save\n  in  ', JSON.stringify(normalise(s)), '\n  out ', JSON.stringify(normalise(got)));
    }
  }
}
ok('500 randomised saves round-trip', randomFails === 0, `${randomFails} mismatched`);

/* -- 5. a damaged code is refused, never half-applied ------------------ */
const good = encode(mid);
let rejected = 0, slipped = 0;
for (let i = 0; i < good.length; i++) {
  if (good[i] === '-') continue;
  for (const sub of ['0', 'Z', '7']) {
    if (good[i] === sub) continue;
    try {
      const out = decode(good.slice(0, i) + sub + good.slice(i + 1));
      // ~1/65536 of mutations can survive a 16-bit checksum by chance; what
      // must never happen is a mutation producing a DIFFERENT valid save.
      if (JSON.stringify(normalise(out)) !== JSON.stringify(normalise(mid))) slipped++;
    } catch { rejected++; }
  }
}
ok('single-character typos do not produce a different save', slipped === 0,
   `${slipped} slipped out of ${rejected + slipped}`);

for (const junk of ['', 'X', 'not a code at all', '!!!!', '-----']) {
  let threw = false;
  try { decode(junk); } catch { threw = true; }
  ok(`junk "${junk}" rejected`, threw);
}

/* -- 6. tolerant of how a human copies it ------------------------------ */
eq('lowercase and spaces', decode(good.toLowerCase().replace(/-/g, ' ')), mid);
eq('no separators at all', decode(good.replace(/-/g, '')), mid);
// Crockford drops I, L, O and U precisely because people write them for 1 and
// 0 — so a hand-copied code containing them must still work.
eq('hand-copied O-for-0 and I-for-1', decode(good.replace(/0/g, 'O').replace(/1/g, 'I')), mid);

/* -- 7. storage helpers ------------------------------------------------ */
class FakeStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i]; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const store = new FakeStorage({
  'mystic-badger.electroUnlocked': '1',
  'mystic-badger.highScore': '404.4',
  'unrelated.key': 'leave me alone'
});
eq('readSave strips the prefix and ignores foreign keys', readSave(store),
   { electroUnlocked: '1', highScore: '404.4' });
writeSave(store, { badgeretteUnlocked: '1' });
eq('writeSave replaces the save wholesale', readSave(store), { badgeretteUnlocked: '1' });
ok('writeSave leaves foreign keys alone', store.getItem('unrelated.key') === 'leave me alone');
eq('describe summarises a save', describe(mid),
   { characters: 4, trophies: 5, highScore: 106.6, totalScore: 12346 });

/* -- 8. the schema still covers the live game -------------------------- */
// These two are the early-warning system: add a storage key, trophy or
// character without extending SaveCode.js and this says so. Nothing breaks in
// the meantime (unknowns overflow safely) — but the code gets longer than it
// needs to be, and this is where you find out.
const gameSrc = readFileSync(join(ROOT, 'src/Game.js'), 'utf8');
const known = new Set([...SCHEMA_BOOLS, ...SCHEMA_INTS, ...SCHEMA_FLOATS,
  ...SCHEMA_CHAR_SETS, 'achievements', 'charUsage', 'character']);
const uncovered = [...new Set([...gameSrc.matchAll(/'mystic-badger\.([A-Za-z0-9_]+)'/g)].map((m) => m[1]))]
  .filter((k) => !known.has(k));
ok('every key Game.js stores is in the schema', uncovered.length === 0, `uncovered: ${uncovered.join(', ')}`);

const achSrc = readFileSync(join(ROOT, 'src/Achievements.js'), 'utf8');
const liveTrophies = [...achSrc.matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1]);
const liveChars = [...achSrc.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
ok('every live trophy is in VOCAB_TROPHIES',
   liveTrophies.every((t) => VOCAB_TROPHIES.includes(t)),
   `missing: ${liveTrophies.filter((t) => !VOCAB_TROPHIES.includes(t)).join(', ')}`);
ok('every live character is in VOCAB_CHARACTERS',
   liveChars.every((c) => VOCAB_CHARACTERS.includes(c)),
   `missing: ${liveChars.filter((c) => !VOCAB_CHARACTERS.includes(c)).join(', ')}`);

/* -- 9. codes from earlier versions still open ------------------------- */
// Real codes, produced by the three versions of this module that were
// actually shipped. Version 1 did not record its own field widths, so
// appending a 49th boolean silently changed how every older code was read —
// these fixtures are here so that can never happen again unnoticed.
const LEGACY_SAVE = {
  badgeretteUnlocked: '1', williamUnlocked: '1', electroUnlocked: '1', muted: '1',
  frogHitsAllTime: '57', summitVisits: '3',
  highScore: '106.6', totalScore: '12345.67',
  achievements: 'score50,score100,zapped,antizapped,hastings',
  scored100: 'badger,william', sandwichDressers: 'mayo,jam',
  character: 'electro', charUsage: JSON.stringify({ badger: 40, william: 12 })
};
const LEGACY_CODES = {
  'v1, as first shipped (48 bools, 65 trophies, 47 characters)':
    '044G0-00001-G9EE8-30000-00D4A-C0RFB-AB0C0-00000-0G080-08200-2042R-K5R8G-00000-002G3-7SX0',
  'v1, after Foil / Error #44 / the Box (51 bools, 50 characters)':
    '044G0-00001-G015S-S0C00-0001M-H9G31-XD9C1-G0000-00201-00108-0080G-B2CQ1-20000-00000-181JC-56'
};
for (const [label, code] of Object.entries(LEGACY_CODES)) {
  let got = null;
  try { got = decode(code); } catch (e) { got = { error: e.message }; }
  eq(`${label} still opens`, got, LEGACY_SAVE);
}

/* -- 10. how big the codes actually are --------------------------------- */
console.log(`      code sizes — empty ${encode({}).length}, mid-game ${encode(mid).length}, maxed ${encode(full).length} chars`);

console.log(`${fail === 0 ? '✅ savecode: ALL PASS' : `‼️  savecode: ${fail} FAILURE(S)`} (${pass} assertions)`);
process.exit(fail ? 1 : 0);
