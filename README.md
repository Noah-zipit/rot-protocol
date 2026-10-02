# ROT PROTOCOL — Pixel Zombie FPS

**Containment failed. Survive the waves.**

A first-person, pixel-art zombie survival shooter that runs in the browser.
Ten waves, three bosses, two maps, one finale. Built with Vite + TypeScript +
Three.js. No backend, no accounts, no downloads beyond the first page load.

## Play

- Pick a map (Graveyard / City) and a loadout (any 2 of Pistol, Shotgun, SMG,
  Rifle — melee knife is always on V).
- Survive 10 waves. Waves 3, 6 and 9 are boss fights:
  **THE ROT KING** (AoE slam + summons), **THE RIPPER** (telegraphed dash),
  **THE BROODMOTHER** (spawns minions, shielded while they live).
- Wave 10 is **PROTOCOL OMEGA**: all three bosses at once. Kill them all to
  win — "CONTAINMENT RESTORED".

### Controls (desktop)

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Look (pointer lock) |
| Left click | Shoot |
| Shift | Sprint |
| Space | Jump |
| C / Ctrl | Slide (while sprinting — momentum, i-frames, FOV kick) |
| R | Reload |
| 1 / 2 | Swap weapons |
| V | Melee |
| M | Mute |
| Esc | Pause |

### Controls (mobile / touch)

Touch devices are auto-detected and get touch controls instead of the
keyboard list:

- **Left joystick** — move · **SPRINT toggle** — sprint
- **Drag right half of screen** — look
- **FIRE** (big, right thumb), **SLIDE** (sprinting only), **JUMP**,
  **RLD** (reload), **1/2** (swap), **MELEE**, pause, sound buttons

Tips: headshots deal 2x damage and freeze the action briefly. The shotgun's
spread tightens while sliding. The Broodmother is immune while any minion
lives — clear the adds first. Slide out of the Rot King's red ring.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # tsc + vite build -> dist/
npm run preview  # serve dist/ locally for a smoke test
```

Stack: Vite 7, TypeScript 5, Three.js (npm). No frameworks.

### Project layout

```
src/
  main.ts    boot, screen state machine, fixed-step loop, event wiring
  sim.ts     60Hz simulation: player, enemies, waves, weapons (no three.js)
  world.ts   three.js renderer: arenas, models, view models, particles, FX
  ui.ts      DOM HUD, screens, loadout, map select, boss bars
  input.ts   keyboard/mouse + touch input -> one InputState per tick
  audio.ts   100% procedural WebAudio SFX
  style.css  all UI styling
public/
  models/enemies/  zombie + monster models
  models/guns/     FPS view models
  favicon.svg
```

### Multiplayer notes (architecture, no netcode yet)

The simulation is already netcode-ready by construction:

- `sim.ts` has zero rendering imports. All state is plain data (`GameState`).
- The sim advances on a fixed 60Hz timestep via `stepSim(state, input, dt)`.
- All player intent enters through the explicit `InputState` struct in
  `input.ts` (moveX/moveY/lookDX/lookDY + edge-triggered flags).
- Every side effect the sim wants to show leaves as a `GameEvent`
  (shots, hits, deaths, waves, boss attacks) — the renderer and audio are
  pure consumers of these events.
- `Math.random()` is used for spread/AI jitter; a future netcode build would
  replace these with a seeded RNG and send only `InputState` per tick.
- Rendering (`world.ts`) only reads state and never mutates it, so a remote
  snapshot could be rendered the same way.

To add netcode later: serialize `GameState` snapshots, exchange `InputState`
per tick, run the same `stepSim` on both ends. No rewrite of game logic.

## Deploy (Vercel, static)

`npm run build` produces `dist/` — a fully static site. Deploy options:

- **Vercel CLI:** `vercel --prod` from this directory (static, no config needed).
- **Vercel dashboard:** import the repo, framework preset "Vite", build
  command `npm run build`, output directory `dist`.
- Any static host works: `npx serve dist` or drop `dist/` on Netlify/CF Pages.

No environment variables, no server functions, no database.

## Asset credits

| Asset | Source | License |
|---|---|---|
| Zombie models (Shambler/Runner/Brute) | Quaternius (quaternius.com) | CC-BY — credit Quaternius |
| Skeleton (Rattler) | Quaternius via poly.pizza | Public Domain (CC0) — credit Quaternius |
| Bat "Goleling" (Shrieker) | Quaternius via poly.pizza | Public Domain (CC0) — credit Quaternius |
| Demon (The Rot King) | Quaternius via poly.pizza | Public Domain (CC0) — credit Quaternius |
| Blue Demon (The Ripper) | Quaternius via poly.pizza | Public Domain (CC0) — credit Quaternius |
| Giant (The Broodmother) | Quaternius via poly.pizza | Public Domain (CC0) — credit Quaternius |
| FPS pack (AKM rig, Glock rig, FPS arms, Mossberg 590A1, Combat Knife) | "FPS pack" bundle by J-Toastie via poly.pizza | CC-BY — credit J-Toastie |
| SMG view model, arenas | Built procedurally in code | — |
| All audio | Procedural WebAudio (no audio files) | — |
| Font | "Press Start 2P" via @fontsource (bundled, offline-safe) | OFL |

The same credits appear on the in-game title screen.

## Performance notes

- Internal render resolution 426x240 upscaled with `image-rendering: pixelated`.
- DevicePixelRatio capped at 1 on mobile; zombie cap 8 (touch) vs 14 (desktop);
  reduced particle pools on touch; tight fog to limit draw distance.
- Auto quality scaler: if FPS stays under ~30 for 3 seconds, effects and
  particle counts step down (2 levels); recovers when FPS stabilizes.
- Total download target: under ~12MB.
