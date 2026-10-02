# ROT PROTOCOL — Design Document

**Locked design, approved by the user (2026-10-02) after a design-first pass,
plus later scope approvals (2 maps, mobile, monster roster, mixed hordes,
10-wave structure, 3 bosses, finale). Build to this document. Do not expand
scope without user approval.**

## Identity

- **Name:** ROT PROTOCOL
- **Tagline:** "Containment failed. Survive the waves."
- **Page title:** `ROT PROTOCOL — Pixel Zombie FPS`
- **Favicon:** pixel-art skull / crosshair (SVG, no emoji)
- **Genre:** First-person zombie pixel-art shooter, wave survival, single-player
  (multiplayer later — architecture must allow it without a rewrite).

## Structure: 10 waves, then victory

The game is NOT endless. Ten waves total:

| Wave | Type | Content |
|---|---|---|
| 1, 2, 4, 5, 7, 8 | Mixed horde | Chaotic mix, never single-type (see spawner) |
| 3 | Boss | THE ROT KING |
| 6 | Boss | THE RIPPER |
| 9 | Boss | THE BROODMOTHER |
| 10 | Finale | PROTOCOL OMEGA: all three bosses together + minion trickle |

Beating wave 10 shows the VICTORY screen: "CONTAINMENT RESTORED" +
score / time / kills / accuracy + PLAY AGAIN. Death at any point shows
YOU DIED with score / wave / kills + TRY AGAIN.

## Enemy roster

All enemies run the same state machine (spawn → seek → chase → attack → die)
with per-type stat/behavior tuning. Models are Quaternius-style blocky
low-poly, all animated, so the cast looks consistent.

| Enemy | Model | Behavior |
|---|---|---|
| SHAMBLER | Quaternius Zombie (Basic variant) | Slow, numerous. Backbone of every horde. |
| RUNNER | Quaternius Zombie (Ribcage variant) | Fast, flanks around the player. |
| BRUTE | Quaternius Zombie (Chubby variant), scaled 1.25x | Slow tank, breaks rhythm. |
| RATTLER | Quaternius Skeleton | Faster than the runner, low HP, erratic zigzag approach. |
| SHRIEKER | Quaternius "Goleling" (a small bat creature) | Flying harasser: hovers above the horde on a sine path, periodically swoops down at the player. Low HP. |
| THE ROT KING (wave 3 boss) | Quaternius Demon, scaled 3.5x + red/coral emissive glow | Slow, very high HP, knockback-immune. AoE slam with ground telegraph ring (dodge by moving/sliding). At 50% HP: roars, summons minions. |
| THE RIPPER (wave 6 boss) | Quaternius Blue Demon, scaled 1.5x | The fast boss. Telegraphed dash: winds up (warning line), charges across the arena. Hitting the player deals heavy damage; hitting a wall stuns it briefly (bonus damage window). |
| THE BROODMOTHER (wave 9 boss) | Quaternius Giant, scaled 2.0x | The summoner. Slow, constantly spawns minions, SHIELDED while any minion lives (kill the adds to drop its shield). |

### Boss waves

Boss waves replace the normal horde spawn: one boss + a slow trickle of
minions (mixed types). Boss HP bar with the boss name across the top of the
HUD during the fight. Kill reward: big score bonus + ammo/health shower.

### Mixed hordes (never wave-segregated)

Every horde wave mixes types: shamblers as the bulk, runners/rattlers woven
in from early waves, shriekers from wave 4, brutes as anchors from wave 4.
Composition gets denser and meaner as waves climb, but every wave feels like
a chaotic mixed horde — never a tidy single-type wave.

## Visual style

- Pixel-art aesthetic via low internal render resolution (~426x240) upscaled
  with `image-rendering: pixelated`.
- Moody night palette: dark blue-grey fog, sickly green zombies, warm orange
  muzzle flash.
- Fog + a small number of flickering point lights (low count).
- UI font: "Press Start 2P" (bundled via @fontsource, offline-safe). No emojis
  anywhere in UI. No AI-generated images.

## Maps

Map select on the title screen. Both maps share the same wave/zombie/boss
systems; spawn points and cover layouts are tuned per map.

- **GRAVEYARD** — tombstones, fences, dead trees, crypt barriers. Open,
  circular sightlines with scattered cover.
- **CITY** — building blocks, wrecked cars, streetlights, road grid.
  Tighter corridors, more hard cover.

## Assets (locked)

| Slot | Source | License |
|---|---|---|
| Zombies (shambler / runner / brute) | Quaternius animated zombie variants | CC-BY (credit Quaternius in README + in-game credits line) |
| Rattler | Quaternius Skeleton | CC0 (credit Quaternius) |
| Shrieker | Quaternius "Goleling" (bat) | CC0 (credit Quaternius) |
| Bosses: Rot King / Ripper / Broodmother | Quaternius Demon / Blue Demon / Giant | CC0 (credit Quaternius) |
| FPS view models: rifle (AKM rig), pistol (Glock rig), animated FPS arms | Poly Pizza "FPS pack" by J-Toastie | CC-BY (credit J-Toastie in README + in-game credits line) |
| Shotgun (Mossberg 590A1) | Poly Pizza, by J-Toastie | CC-BY (credit J-Toastie) |
| Melee (Combat Knife) | Poly Pizza, by J-Toastie | CC-BY (credit J-Toastie) |
| SMG | Procedural blocky SMG in code (matches J-Toastie style) | own |
| Environment: Graveyard | Kenney "Graveyard Kit" (14 pieces) | CC0 (credit Kenney in README + in-game credits line) |
| Environment: City | Poly Pizza "City Pack" by dreamdev — 9 models by Quaternius, Kenney, Kay Lousberg | CC0 (credit all three in README + in-game credits line) |
| Audio | 100% procedural WebAudio (gunshots, reloads, groans, hits, wave horn, boss roars). Mute: M | own |

Total game weight target: under ~12MB.

## Mechanics (locked)

### Controls

Desktop (pointer lock):

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Left click | Shoot |
| Shift | Sprint |
| Space | Small jump |
| C or Ctrl | Slide (only while sprinting) |
| R | Reload |
| 1 / 2 | Swap weapons |
| V | Melee attack |
| M | Mute toggle |
| Esc | Pause |

Mobile / touch (auto-detected, touch UI replaces the keyboard list):

| Input | Action |
|---|---|
| Left virtual joystick | Move (deadzone 0.15) |
| SPRINT toggle button | Sprint (joystick pushed forward) |
| Drag right half of screen | Look |
| FIRE (big, right thumb) | Shoot |
| SLIDE | Slide (active only while sprinting) |
| JUMP | Jump |
| RELOAD | Reload |
| 1/2 swap button | Alternate weapon slots |
| Melee button | Melee attack |
| Pause button | Pause |
| Mute button | Mute toggle |

### Slide (signature mechanic)

- Trigger: sprint + crouch key. Momentum-based glide, brief i-frames at start,
  camera dip, FOV kick. Shotgun spread tightens mid-slide.

### Weapons (hitscan)

- **Pistol** — infinite reserve ammo. Medium damage, medium rate.
- **Shotgun** — 5-pellet spread (tightens mid-slide). High close damage.
- **SMG** — fast fire, low damage per bullet.
- **Rifle** — slow fire, high damage, pierces through zombies.
- **Melee** — V key, short-range swing fallback.
- Loadout screen before each run: pick any 2 primaries + melee fallback.
  Ammo is scarce per weapon to force rotation. R reloads, 1/2 swaps.

### Hit detection

Headshots: bonus damage (2x) + hit-stop freeze frames + distinct sound.
Melee: short-range arc swing. Rifle pierces with falloff per enemy.

### Waves

- Breather banner ("WAVE N INCOMING", boss waves get a warning banner) before
  each wave. Wave number, zombies remaining, and score on the HUD.
- Boss waves: boss + minion trickle. Wave 10 (PROTOCOL OMEGA): all three
  bosses together + steady mixed minion trickle, with generous ammo/health
  drops during the finale.

### Juice (mandatory, not optional)

Screen shake on shoot/hit, hit-stop on headshots, muzzle flash point light,
pixel blood particles, red damage vignette, white hitmarker, kill score
popups, weapon bob and sway, damage numbers on boss (HP bar), telegraph
rings/lines for boss attacks.

### HUD

Health bar + number, weapon name, ammo mag/reserve, wave number, zombies
remaining, score, kills, crosshair expanding with movement, slide indicator,
damage vignette, wave banner, boss HP bar(s) with names during boss fights.

### Screens

1. **Title** — ROT PROTOCOL branding, tagline, map select (Graveyard/City),
   controls list (or touch note), ENTER THE ARENA, asset credits line.
2. **Loadout** — pick 2 primaries, DEPLOY.
3. **Pause** (Esc / pause button) — resume / abandon run.
4. **Game over** — YOU DIED, score / wave / kills, TRY AGAIN.
5. **Victory** — CONTAINMENT RESTORED, score / time / kills / accuracy,
   PLAY AGAIN.

## Architecture (multiplayer later — NO netcode now)

- Fixed-timestep simulation: 60Hz accumulator, decoupled from rendering.
- Game state (player, zombies, projectiles, score) in plain data objects,
  separate from the Three.js scene graph.
- Explicit `Input` struct consumed by the sim each tick.
- See README "Multiplayer notes".

## Performance (weak laptop + poor internet + mobile)

- Low internal render resolution (~426x240), upscaled.
- Low-poly assets only; minimal light count; fog for cheap depth.
- No per-frame allocations in hot loops; reuse vectors/objects.
- DPR capped at 1 on mobile; reduced particle counts on mobile; lower
  concurrent-zombie cap on touch (8 vs 14); tight fog to limit draw distance.
- Auto quality scaler: if FPS drops below ~30 for a few seconds, reduce
  particle counts / effects automatically (recovers when FPS stabilizes).
- Total download under ~12MB.
- Touch code paths are guarded; game logic is identical across inputs.

## Out of scope

- Multiplayer netcode, settings menu, leaderboards, AI-generated imagery,
  emojis in UI.
