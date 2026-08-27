/**
 * SaveCode.js — turning a browser's worth of progress into something you can
 * write on the back of an envelope.
 *
 * The game keeps everything in localStorage, which is not as permanent as it
 * sounds: clearing site data wipes it, a different device never had it, and
 * Safari deletes it outright after seven days without a visit. This module
 * packs the whole save into a short code the player can copy, screenshot or
 * write down, and unpacks it again anywhere.
 *
 * Design rules, in order of importance:
 *
 *   1. NOTHING IS SILENTLY LOST. The schema below names the keys it knows how
 *      to pack tightly. Every other `mystic-badger.*` key in localStorage is
 *      swept into an `extras` section verbatim, and unknown members of the
 *      achievement / character vocabularies go the same way. A future key that
 *      nobody remembered to add here makes the code slightly longer — it does
 *      not make the code wrong.
 *   2. A WRONG CODE IS REJECTED, NOT HALF-APPLIED. Every code carries a
 *      checksum, and decode() either returns a complete save or throws. The
 *      caller writes nothing until it has a whole object in hand.
 *   3. OLD CODES KEEP WORKING. The vocabularies are frozen and append-only,
 *      and byte 0 is a format version. Never reorder VOCAB_* — only append.
 *
 * Format. Everything optional sits behind a presence bit, because a typical
 * save has most sections empty and a code you might write down should not be
 * paying for sets nobody has started yet.
 *
 *   byte 0        format version
 *   bitfield      SCHEMA_BOOLS, one bit each
 *   byte          which optional sections follow (see SECTION_*)
 *   varints       SCHEMA_INTS, in order
 *   float×2       SCHEMA_FLOATS — a mode byte then the value (see writeFloat)
 *   [trophies]    bitfield over VOCAB_TROPHIES
 *   [char sets]   scored100 / scored200 / scored300 / sandwichDressers, each
 *                 sparse (a count then one index byte each) or, past six
 *                 members, a flat bitfield — whichever is smaller
 *   [character]   selected character index
 *   [usage]       bitfield of who has been played, then a varint tally each
 *   [extras]      varint count, then len+text key / len+text value pairs
 *   2 bytes       FNV-1a checksum of everything above
 *
 * The bytes are then Crockford base32-encoded (no I, L, O or U, so there is
 * nothing to misread) and grouped in fives.
 *
 * Note that decode() normalises order: trophies and set members come back in
 * vocabulary order rather than the order they happened to be written in. The
 * game holds all of these in Sets, so order carries no meaning.
 */

export const SAVE_VERSION = 2;

/**
 * A code is read with the SIZES IT WAS WRITTEN WITH, not today's.
 *
 * Version 1 hard-coded the current array lengths into the reader, which made
 * "append only" necessary but not sufficient: appending a 49th boolean grew
 * that bitfield from six bytes to seven, and every older code was then read
 * at the wrong width. Version 2 writes the lengths into the code itself, so
 * the lists can grow freely and old codes keep meaning what they meant.
 *
 * These are the layouts version 1 was actually issued with, newest first.
 * A v1 code is tried against each and the one that consumes the payload
 * exactly is the right one.
 */
const LEGACY_LAYOUTS = [
  { bools: 51, trophies: 68, characters: 50, charSets: 4 }, // + the long-haul trophies
  { bools: 51, trophies: 65, characters: 50, charSets: 4 }, // + Foil, Error #44, the Box
  { bools: 48, trophies: 65, characters: 47, charSets: 4 }  // as first shipped
];

/** The sizes the current arrays imply. */
function currentLayout() {
  return {
    bools: SCHEMA_BOOLS.length,
    trophies: VOCAB_TROPHIES.length,
    characters: VOCAB_CHARACTERS.length,
    charSets: SCHEMA_CHAR_SETS.length
  };
}
export const SAVE_PREFIX = 'mystic-badger.';

/** Human-facing label for the code, used in the UI and the backup file. */
export const SAVE_LABEL = 'BADGER-1';

/* ------------------------------------------------------------------ */
/*  Frozen vocabularies — APPEND ONLY. Reordering invalidates every    */
/*  code ever issued. New ids may be added at the end at any time;     */
/*  anything missing from these lists still round-trips via extras.    */
/* ------------------------------------------------------------------ */

export const VOCAB_TROPHIES = [
  'score50', 'score100', 'score200', 'score300', 'score400', 'score500',
  'score600', 'decimal', 'tower3', 'tower10', 'holeinone', 'tube', 'lakebed',
  'star', 'cloud', 'rip', 'unlock1', 'unlock5', 'unlock10', 'allstars',
  'allclouds', 'allcherries', 'alleggs', 'allsky', 'train', 'yoyo', 'c100',
  'c200', 'c300', 'play5', 'play10', 'play20', 'allstations', 'mondrian',
  'firforest', 'polarsummit', 'turnipwin', 'snooker', 'inapickle',
  'birdfeather', 'woodlie', 'guava', 'hastings', 'blisters', 'whirlylucky',
  'inaspin', 'chimptactoe', 'owlin4u', 'afk', 'plattytubes', 'lifeaquatic',
  'afkc', 'charredmeander', 'farmervspig', 'mysticsquared', 'frogs50',
  'frogs100', 'mysticcubed', 'pointproved', 'lifetime10k', 'lifetime50k',
  'lifetime100k', 'frogspawn', 'zapped', 'antizapped',
  'play40', 'total50', 'total100', 'c400',
  'unlock20', 'unlock50', 'unlockroll', 'doppelganger', 'charredishard',
  'boffline', 'starbilly', 'garyair', 'candyslide', 'nellyfive',
  'parsleyout', 'crisps', 'mcdcoffee', 'taradouble', 'prettyweird',
  'fedora180', 'nemesis', 'nucleustime', 'laika',
  'juliecones', 'cactusair', 'nightvision', 'tudorround', 'meetmaker',
  'badrequest', 'livewire', 'thirdclass', 'blueberryrain'
];

export const VOCAB_CHARACTERS = [
  'badger', 'badgerette', 'hughes', 'boffington', 'william', 'edith',
  'rhombus', 'ginsberg', 'magnus', 'boddington', 'error42', 'mayo',
  'perpbird', 'marblella', 'fir', 'margaret', 'julie', 'turnip',
  'sweatshirt', 'jam', 'dodeca', 'polarpear', 'nighteye', 'pinepenguin',
  'billy', 'pickle', 'glassbadger', 'mcdonovan', 'prunella', 'gary',
  'candy', 'cactusballoon', 'nelly', 'trifedora', 'parsley', 'vapour',
  'spirit', 'chimpy', 'owl', 'snappy', 'bacon', 'robofarmer', 'frosch',
  'error43', 'nucleus', 'tudor', 'electro',
  'foil', 'error44', 'cardboard',
  'tapir', 'postboxer', 'pcork', 'wolk', 'muffin',
  'error45', 'wagnus', 'reindeer'
];

/* ------------------------------------------------------------------ */
/*  Schema — the keys packed tightly. Suffixes only; SAVE_PREFIX is    */
/*  added back on. APPEND ONLY, same as the vocabularies.              */
/* ------------------------------------------------------------------ */

/** One bit each. '1' is true; anything else is false. */
export const SCHEMA_BOOLS = [
  'badgeretteUnlocked', 'hughesUnlocked', 'boffingtonUnlocked',
  'williamUnlocked', 'edithUnlocked', 'rhombusUnlocked', 'ginsbergUnlocked',
  'magnusUnlocked', 'boddingtonUnlocked', 'error42Unlocked', 'mayoUnlocked',
  'perpbirdUnlocked', 'marblellaUnlocked', 'firUnlocked', 'margaretUnlocked',
  'julieUnlocked', 'turnipUnlocked', 'sweatshirtUnlocked', 'jamUnlocked',
  'dodecaUnlocked', 'polarpearUnlocked', 'nightEyeUnlocked',
  'pinepenguinUnlocked', 'billyUnlocked', 'pickleStickUnlocked',
  'glassBadgerUnlocked', 'mcdonovanUnlocked', 'prunellaUnlocked',
  'garyUnlocked', 'candyUnlocked', 'cactusBalloonUnlocked', 'nellyUnlocked',
  'triFedoraUnlocked', 'parsleyUnlocked', 'vapourBadgerUnlocked',
  'spiritBadgerUnlocked', 'chimpyUnlocked', 'pastryOwlUnlocked',
  'snappyUnlocked', 'baconUnlocked', 'roboFarmerUnlocked', 'froschUnlocked',
  'error43Unlocked', 'nucleusUnlocked', 'tudorUnlocked', 'electroUnlocked',
  'muted', 'bloom',
  'foilUnlocked', 'error44Unlocked', 'cardboardUnlocked',
  'tapirUnlocked', 'postboxerUnlocked', 'pcorkUnlocked', 'wolkUnlocked',
  'muffinUnlocked', 'error45Unlocked', 'wagnusUnlocked', 'reindeerUnlocked'
];

/**
 * Whole numbers, stored as varints.
 *
 * DO NOT APPEND TO THIS LIST. Unlike the bools, trophies, characters and
 * char-sets, this section carries no length in the v2 header — the reader
 * takes exactly SCHEMA_INTS.length varints — so adding one here misreads
 * every code already issued. A new counter needs no entry anyway: any
 * mystic-badger.* key this schema doesn't know is swept into `extras` and
 * round-trips verbatim (raisinsAllTime is carried that way). Growing this
 * list properly means a format v3 with an int count in the header.
 */
export const SCHEMA_INTS = [
  'frogHitsAllTime', 'summitVisits', 'helterVisits', 'fridgeClicks',
  'whirlEntries'
];

/** Scores, stored as their exact text so decimals survive to the last digit. */
export const SCHEMA_FLOATS = ['highScore', 'totalScore'];

/** Comma-joined sets of character keys. */
export const SCHEMA_CHAR_SETS = [
  'scored100', 'scored200', 'scored300', 'sandwichDressers',
  'scored400'
];

const KEY_TROPHIES = 'achievements';
const KEY_USAGE = 'charUsage';
const KEY_CHARACTER = 'character';

/** Every suffix the schema handles itself — used to spot what it doesn't. */
const SCHEMA_KNOWN = new Set([
  ...SCHEMA_BOOLS, ...SCHEMA_INTS, ...SCHEMA_FLOATS, ...SCHEMA_CHAR_SETS,
  KEY_TROPHIES, KEY_USAGE, KEY_CHARACTER
]);

/* ------------------------------------------------------------------ */
/*  Byte plumbing                                                      */
/* ------------------------------------------------------------------ */

class Writer {
  constructor() { this.bytes = []; }
  byte(b) { this.bytes.push(b & 0xff); }
  /** LEB128 unsigned varint — one byte for anything under 128. */
  varint(n) {
    let v = Math.max(0, Math.floor(n));
    // Beyond 2^53 the arithmetic stops being exact; nothing here goes near it,
    // but clamp rather than emit a corrupt run of bytes.
    if (!Number.isFinite(v)) v = 0;
    do {
      let part = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) part |= 0x80;
      this.byte(part);
    } while (v > 0);
  }
  bits(flags) {
    for (let i = 0; i < flags.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < flags.length; j++) if (flags[i + j]) b |= 1 << j;
      this.byte(b);
    }
  }
  text(s) {
    const enc = new TextEncoder().encode(String(s));
    this.varint(enc.length);
    for (const b of enc) this.byte(b);
  }
  /**
   * Scores are the one place decimals matter — 106.6 unlocks a trophy and
   * 63.14159 turns up in lifetime totals. Almost every score lands on a whole
   * number of pennies, so store hundredths as a varint and only fall back to
   * text when that would not reproduce the original string exactly.
   */
  float(raw) {
    if (raw === undefined || raw === null || raw === '' || raw === '0') {
      this.byte(FLOAT_ZERO);
      return;
    }
    const text = String(raw);
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) {
      const hundredths = Math.round(n * 100);
      if (Number.isSafeInteger(hundredths) && String(hundredths / 100) === text) {
        this.byte(FLOAT_HUNDREDTHS);
        this.varint(hundredths);
        return;
      }
    }
    this.byte(FLOAT_TEXT);
    this.text(text);
  }
}

const FLOAT_ZERO = 0;
const FLOAT_HUNDREDTHS = 1;
const FLOAT_TEXT = 2;

/* Presence bits for the optional sections, in the order they are written. */
const SECTION_TROPHIES = 1 << 0;
const SECTION_CHARACTER = 1 << 1;
const SECTION_USAGE = 1 << 2;
const SECTION_EXTRAS = 1 << 3;
/* One bit per entry in SCHEMA_CHAR_SETS, starting here. */
const SECTION_CHAR_SETS = 4;

/* A character set is stored sparsely up to this many members, and as a flat
 * bitfield past it — 47 characters need 6 bytes as a bitfield, so sparse wins
 * while the count plus one index byte each stays under that. */
const SPARSE_LIMIT = 5;

class Reader {
  constructor(bytes) { this.bytes = bytes; this.i = 0; }
  byte() {
    if (this.i >= this.bytes.length) throw new Error('code ended early');
    return this.bytes[this.i++];
  }
  varint() {
    let result = 0;
    let shift = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return result;
      shift *= 128;
      if (shift > 2 ** 53) throw new Error('varint too long');
    }
  }
  bits(count) {
    const out = [];
    for (let i = 0; i < count; i += 8) {
      const b = this.byte();
      for (let j = 0; j < 8 && i + j < count; j++) out.push((b >> j & 1) === 1);
    }
    return out;
  }
  text() {
    const len = this.varint();
    if (this.i + len > this.bytes.length) throw new Error('code ended early');
    const slice = this.bytes.slice(this.i, this.i + len);
    this.i += len;
    return new TextDecoder().decode(new Uint8Array(slice));
  }
  float() {
    const mode = this.byte();
    if (mode === FLOAT_ZERO) return null;
    if (mode === FLOAT_HUNDREDTHS) return String(this.varint() / 100);
    if (mode === FLOAT_TEXT) return this.text();
    throw new Error('unreadable score in that code');
  }
}

/** FNV-1a, folded to 16 bits — plenty to catch a mistyped character. */
function checksum(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h >>> 16) ^ h) & 0xffff;
}

/* ------------------------------------------------------------------ */
/*  Crockford base32 — no I, L, O or U, so there is nothing to misread */
/* ------------------------------------------------------------------ */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < ALPHABET.length; i++) m.set(ALPHABET[i], i);
  // The four excluded letters are the ones people write anyway. Accept them
  // as the digits they look like, so a hand-copied code still works.
  m.set('I', 1); m.set('L', 1); m.set('O', 0); m.set('U', 0);
  return m;
})();

function base32Encode(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '');
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = DECODE_MAP.get(ch);
    if (v === undefined) throw new Error(`unexpected character "${ch}" in the code`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Save <-> plain object                                              */
/* ------------------------------------------------------------------ */

/**
 * Read every `mystic-badger.*` key out of a storage-like object.
 * @param {Storage} storage
 * @returns {Object<string,string>} suffix -> value
 */
export function readSave(storage) {
  const save = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(SAVE_PREFIX)) {
      save[key.slice(SAVE_PREFIX.length)] = storage.getItem(key);
    }
  }
  return save;
}

/**
 * Write a decoded save back. Every existing `mystic-badger.*` key is cleared
 * first, so restoring gives you exactly the save in the code rather than the
 * code merged on top of whatever was already there — a half-merged save would
 * be a confusing thing to hand somebody.
 */
export function writeSave(storage, save) {
  const doomed = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(SAVE_PREFIX)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
  for (const [suffix, value] of Object.entries(save)) {
    storage.setItem(SAVE_PREFIX + suffix, String(value));
  }
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Pack a save object into a code.
 * @param {Object<string,string>} save suffix -> value, as from readSave()
 * @returns {string} the grouped, human-copyable code
 */
export function encode(save) {
  const w = new Writer();
  w.byte(SAVE_VERSION);
  // Self-describing: whoever reads this later knows exactly how wide each
  // variable-length field is, whatever these arrays have grown to by then.
  const layout = currentLayout();
  w.varint(layout.bools);
  w.varint(layout.trophies);
  w.varint(layout.characters);
  w.varint(layout.charSets);

  // Anything the schema cannot pack tightly rides along verbatim.
  const extras = {};
  for (const [suffix, value] of Object.entries(save)) {
    if (!SCHEMA_KNOWN.has(suffix)) extras[suffix] = value;
  }

  // Work out what is actually present before writing anything, so the
  // presence byte can be emitted up front and empty sections cost one bit.
  const trophies = new Set(splitList(save[KEY_TROPHIES]));
  const known = trophies.size && VOCAB_TROPHIES.some((id) => trophies.has(id));
  const strayTrophies = [...trophies].filter((id) => !VOCAB_TROPHIES.includes(id));
  if (strayTrophies.length) extras[`+${KEY_TROPHIES}`] = strayTrophies.join(',');

  const charSets = SCHEMA_CHAR_SETS.map((k) => {
    const members = new Set(splitList(save[k]));
    const stray = [...members].filter((c) => !VOCAB_CHARACTERS.includes(c));
    if (stray.length) extras[`+${k}`] = stray.join(',');
    return VOCAB_CHARACTERS.map((c, i) => i).filter((i) => members.has(VOCAB_CHARACTERS[i]));
  });

  const selected = VOCAB_CHARACTERS.indexOf(save[KEY_CHARACTER]);
  if (selected < 0 && save[KEY_CHARACTER]) extras[`+${KEY_CHARACTER}`] = save[KEY_CHARACTER];

  let usage = {};
  try { usage = JSON.parse(save[KEY_USAGE] || '{}') || {}; } catch (e) { usage = {}; }
  const played = VOCAB_CHARACTERS.map((c) => Number(usage[c]) > 0);
  const anyPlayed = played.some(Boolean);
  const strayUsage = {};
  for (const [c, n] of Object.entries(usage)) {
    if (!VOCAB_CHARACTERS.includes(c) && Number(n) > 0) strayUsage[c] = Number(n);
  }
  if (Object.keys(strayUsage).length) extras[`+${KEY_USAGE}`] = JSON.stringify(strayUsage);

  const extraKeys = Object.keys(extras).sort();

  let sections = 0;
  if (known) sections |= SECTION_TROPHIES;
  if (selected >= 0) sections |= SECTION_CHARACTER;
  if (anyPlayed) sections |= SECTION_USAGE;
  if (extraKeys.length) sections |= SECTION_EXTRAS;
  charSets.forEach((members, i) => {
    if (members.length) sections |= 1 << (SECTION_CHAR_SETS + i);
  });

  w.bits(SCHEMA_BOOLS.map((k) => save[k] === '1'));
  w.varint(sections);
  for (const k of SCHEMA_INTS) w.varint(parseInt(save[k], 10) || 0);
  for (const k of SCHEMA_FLOATS) w.float(save[k]);

  if (known) w.bits(VOCAB_TROPHIES.map((id) => trophies.has(id)));

  for (const members of charSets) {
    if (!members.length) continue;
    if (members.length <= SPARSE_LIMIT) {
      w.byte(members.length);
      for (const i of members) w.byte(i);
    } else {
      w.byte(0xff);
      const set = new Set(members);
      w.bits(VOCAB_CHARACTERS.map((c, i) => set.has(i)));
    }
  }

  if (selected >= 0) w.byte(selected);

  // Per-character run tallies: a bitfield of who has been played, then one
  // varint per set bit. Most saves have played a handful of heroes, so this
  // costs a few bytes rather than one per character on the roster.
  if (anyPlayed) {
    w.bits(played);
    VOCAB_CHARACTERS.forEach((c, i) => { if (played[i]) w.varint(Number(usage[c])); });
  }

  if (extraKeys.length) {
    w.varint(extraKeys.length);
    for (const k of extraKeys) {
      w.text(k);
      w.text(extras[k]);
    }
  }

  const sum = checksum(w.bytes);
  w.byte(sum & 0xff);
  w.byte((sum >> 8) & 0xff);

  return group(base32Encode(w.bytes));
}

/**
 * Unpack a code. Throws if it is damaged, truncated or from the future —
 * callers must let that reach the player rather than importing a partial save.
 * @param {string} code
 * @returns {Object<string,string>} suffix -> value, ready for writeSave()
 */
/**
 * Parse a payload against one layout. Throws if it runs out of bytes.
 * @returns {{save: Object, consumed: number}} how far it got, so the caller
 *   can tell a correct layout (consumes everything) from a wrong guess.
 */
function parsePayload(body, layout, versioned) {
  const r = new Reader(body);
  r.byte(); // version, already read by the caller
  if (versioned) {
    layout = {
      bools: r.varint(),
      trophies: r.varint(),
      characters: r.varint(),
      charSets: r.varint()
    };
  }

  const save = {};
  // A code may carry FEWER entries than we know about (older) or MORE (newer,
  // if this build is behind). Read exactly what is there; anything past the
  // end of our own list is a flag we have no name for, so it is dropped, and
  // anything short simply stays false.
  const bools = r.bits(layout.bools);
  for (let i = 0; i < Math.min(layout.bools, SCHEMA_BOOLS.length); i++) {
    if (bools[i]) save[SCHEMA_BOOLS[i]] = '1';
  }
  const sections = versioned ? r.varint() : r.byte();
  for (const k of SCHEMA_INTS) {
    const n = r.varint();
    if (n > 0) save[k] = String(n);
  }
  for (const k of SCHEMA_FLOATS) {
    const raw = r.float();
    if (raw !== null) save[k] = raw;
  }

  const trophies = [];
  if (sections & SECTION_TROPHIES) {
    const bits = r.bits(layout.trophies);
    for (let i = 0; i < Math.min(layout.trophies, VOCAB_TROPHIES.length); i++) {
      if (bits[i]) trophies.push(VOCAB_TROPHIES[i]);
    }
  }

  const charSets = {};
  for (let n = 0; n < layout.charSets; n++) {
    const key = SCHEMA_CHAR_SETS[n];
    const members = [];
    if (sections & (1 << (SECTION_CHAR_SETS + n))) {
      const header = r.byte();
      if (header === 0xff) {
        const bits = r.bits(layout.characters);
        for (let i = 0; i < Math.min(layout.characters, VOCAB_CHARACTERS.length); i++) {
          if (bits[i]) members.push(VOCAB_CHARACTERS[i]);
        }
      } else {
        for (let i = 0; i < header; i++) {
          const c = VOCAB_CHARACTERS[r.byte()];
          if (c) members.push(c);
        }
      }
    }
    // A set this build has no name for still had to be READ, to keep the
    // stream in step — it just has nowhere to go.
    if (key) charSets[key] = members;
  }
  for (const k of SCHEMA_CHAR_SETS) if (!charSets[k]) charSets[k] = [];

  if (sections & SECTION_CHARACTER) {
    save[KEY_CHARACTER] = VOCAB_CHARACTERS[r.byte()] || 'badger';
  }

  const usage = {};
  if (sections & SECTION_USAGE) {
    const playedBits = r.bits(layout.characters);
    for (let i = 0; i < layout.characters; i++) {
      if (playedBits[i]) {
        const n = r.varint();
        if (VOCAB_CHARACTERS[i]) usage[VOCAB_CHARACTERS[i]] = n;
      }
    }
  }

  const extras = {};
  if (sections & SECTION_EXTRAS) {
    const extraCount = r.varint();
    for (let i = 0; i < extraCount; i++) {
      const k = r.text();
      extras[k] = r.text();
    }
  }

  // Fold the overflow sections back into the values they came from.
  for (const [k, v] of Object.entries(extras)) {
    if (!k.startsWith('+')) { save[k] = v; continue; }
    const target = k.slice(1);
    if (target === KEY_TROPHIES) trophies.push(...splitList(v));
    else if (target === KEY_CHARACTER) save[KEY_CHARACTER] = v;
    else if (target === KEY_USAGE) {
      try { Object.assign(usage, JSON.parse(v) || {}); } catch (e) { /* ignore */ }
    } else if (charSets[target]) charSets[target].push(...splitList(v));
    else save[target] = v;
  }

  if (trophies.length) save[KEY_TROPHIES] = trophies.join(',');
  for (const [k, members] of Object.entries(charSets)) {
    if (members.length) save[k] = members.join(',');
  }
  if (Object.keys(usage).length) save[KEY_USAGE] = JSON.stringify(usage);

  return { save, consumed: r.i };
}

/**
 * Unpack a code. Throws if it is damaged, truncated or from the future —
 * callers must let that reach the player rather than importing a partial save.
 * @param {string} code
 * @returns {Object<string,string>} suffix -> value, ready for writeSave()
 */
export function decode(code) {
  const bytes = base32Decode(code);
  if (bytes.length < 4) throw new Error('that code is too short to be a save');

  // The trailing checksum covers everything before it. base32 pads up to a
  // byte boundary, so a stray zero byte at the end is expected, not damage.
  let body = null;
  for (const candidate of [bytes.length, bytes.length - 1]) {
    if (candidate < 3) continue;
    const sum = bytes[candidate - 2] | (bytes[candidate - 1] << 8);
    const head = bytes.slice(0, candidate - 2);
    if (checksum(head) === sum) { body = head; break; }
  }
  if (!body) throw new Error('that code has a typo in it somewhere — check and try again');

  const version = body[0];
  if (version > SAVE_VERSION) {
    throw new Error('that code was made by a newer version of the game');
  }

  if (version >= 2) return parsePayload(body, null, true).save;

  // Version 1 did not record its own sizes. Try the layouts it was issued
  // with and take the one that consumes the payload exactly — a wrong guess
  // either runs off the end or leaves bytes over.
  let best = null;
  for (const layout of LEGACY_LAYOUTS) {
    try {
      const got = parsePayload(body, layout, false);
      if (got.consumed === body.length) return got.save;
      if (!best) best = got.save;
    } catch (e) { /* wrong layout: try the next */ }
  }
  if (best) return best;
  throw new Error('that code could not be read — it may be from an older version');
}

/** Groups of five, which is how people read long codes without losing their place. */
function group(text) {
  return (text.match(/.{1,5}/g) || []).join('-');
}

/**
 * A one-line summary of what a code contains, so the player can see what they
 * are about to overwrite before they commit to it.
 */
export function describe(save) {
  const chars = SCHEMA_BOOLS.filter((k) => k.endsWith('Unlocked') && save[k] === '1').length + 1;
  const trophies = splitList(save[KEY_TROPHIES]).length;
  const high = Math.round(parseFloat(save.highScore || '0') * 100) / 100;
  const total = Math.round(parseFloat(save.totalScore || '0'));
  return { characters: chars, trophies, highScore: high, totalScore: total };
}
