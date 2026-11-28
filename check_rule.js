const { loadSimulator } = require("./sim_loader.js");
const sim = loadSimulator("script.js");
const P = ["N", "E", "S", "W"];
let maxHold = 0, earlySwitch = 0, switches = 0, keptWith12 = 0, checks12 = 0, emptyKeep = 0, minGreen = 1e9, runsN = 0;
for (let sc = 0; sc < 3; sc++) for (let d = 0; d < 3; d++) for (const seed of [11, 12, 13, 14]) {
  sim.setCfg(sc, d, seed); sim.newRun(false); const r = sim.runs.adaptive; runsN++;
  let hold = 0, prevStage = r.stage, lastGreenElapsed = 0, lastPhase = null;
  for (let t = 0; t < 4200; t++) {
    const before = { stage: r.stage, el: r.greenElapsed, phase: r.phase, cnt: Object.fromEntries(P.map(p => [p, r.queues[p].length])) };
    sim.updateRun(r, 0.05);
    if (before.stage === "green" && r.stage === "yellow" && /cut short/.test(r.decision)) { switches++; if (before.el < 10) earlySwitch++; }
    if (before.stage === "green" && r.stage === "yellow") { minGreen = Math.min(minGreen, before.el); }
    if (r.stage === "green" && !r.hop && r.greenElapsed >= 10) {
      const cur = r.queues[r.phase].length; const best = Math.max(...P.filter(p => p !== r.phase).map(p => r.queues[p].length));
      if (best - cur >= 3) { hold += 0.05; maxHold = Math.max(maxHold, hold); } else { hold = 0; if (best - cur >= 0 && best - cur <= 2 && cur > 0) keptWith12++; }
    } else hold = 0;
  }
}
console.log({ runs: runsN, ruleSwitches: switches, switchesBeforeMin10s: earlySwitch, longestSecondsStayingGreenWhileAnotherRoadHas3PlusMore: maxHold.toFixed(2), shortestGreenBeforeAnySwitch: minGreen.toFixed(1), keptGreenWhenDifferenceWas0to2: keptWith12 > 0 });
