# Tests

No dependencies, no test framework. Two suites:

```bash
tests/run.sh                 # both, with a server started and cleaned up for you
node tests/savecode.test.mjs # just the codec — pure node, runs anywhere
```

| Suite | What it covers |
|---|---|
| `savecode.test.mjs` | The save-code codec: round-trips (including 500 randomised saves), exact decimal preservation, unknown-key overflow, corruption rejection, hand-copy tolerance, and whether the schema still covers everything `Game.js` stores. |
| `browser.test.mjs` | Rules that need the game running: which heroes count as badgers, the transmission tower's damage and once-per-run payout, every Electro Badger unlock case and its near-misses, and Save & Restore end to end — including wiping the browser and restoring into a fresh profile. |

The browser suite needs Playwright. It looks in
`/opt/node22/lib/node_modules/playwright/index.js`; set `PLAYWRIGHT_PATH` to
point elsewhere. If it can't find it, the suite skips rather than fails.

## Two traps worth knowing before you add a test

**Trophies and unlocks are lifetime records.** `achievements.has('zapped')`
stays true forever once earned, so it tells you nothing about the run in front
of you. Assert on per-run state — health, points, the unlock flag you just
cleared — not on a trophy being absent.

**Milestones are credited retroactively.** Seed a lifetime score and the game
awards `lifetime10k`, `pointproved` and friends the moment it loads. A test
that seeds six trophies and expects six back will fail through no fault of the
code. Assert that the seeded ones *survived*, not that the total is unchanged.

## Driving a run from a test

`beginRun()` only works from the menu — it returns early otherwise. Every run
after the first arrives through `restart()`, which re-reads the character
selection from the game-over screen, so pin the hero again afterwards:

```js
if (g.inMenu) { g.setCharacter(c); g.beginRun(false, 'easy'); }
else { g.restart(false, 'easy'); }
g.setCharacter(c);
```
