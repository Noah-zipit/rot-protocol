import { createGame, startRun, stepSim, FIXED_DT, type InputState } from "../src/sim";

function blankInput(): InputState {
  return {
    moveX: 0, moveY: 0, sprint: false, jumpPressed: false, slidePressed: false,
    fireHeld: false, reloadPressed: false, swap1: false, swap2: false,
    meleePressed: false, pausePressed: false, interactPressed: false, usePressed: false,
    lookDX: 0, lookDY: 0,
  };
}

const sim = createGame("graveyard", false);
startRun(sim, ["pistol", "shotgun"]);
const inp = blankInput();
let nanAt = -1;
for (let f = 0; f < 1200; f++) {
  inp.moveY = f % 120 < 60 ? 1 : -1;
  inp.fireHeld = f % 45 === 0;
  inp.lookDX = 0.01;
  stepSim(sim, inp, FIXED_DT);
  for (const e of sim.enemies) {
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.z)) { nanAt = f; break; }
  }
  if (nanAt >= 0) break;
  if (sim.over || sim.won) break;
}
console.log(nanAt >= 0 ? `NAN at frame ${nanAt}` : "no NaN in 1200 frames", "wave=", sim.wave);
