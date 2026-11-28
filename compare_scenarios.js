// Compares the fixed timer with the adaptive controller on every scenario x demand.
// Usage: node compare_scenarios.js   (fresh seeds 21-28; mean wait includes cars still queued)
const { loadSimulator } = require("./sim_loader.js");
const sim = loadSimulator("script.js");
const names = ["Morning rush", "Balanced flow", "Event surge"], demands = ["Low", "Medium", "High"];
const seeds = [21, 22, 23, 24, 25, 26, 27, 28];
const tot = { f: [0, 0, 0], a: [0, 0, 0], n: 0 };
const f1 = (x) => x.toFixed(1);
console.log("| Scenario / demand | Fixed wait | Adaptive wait | Fixed cleared | Adaptive cleared | Wait saved | Extra cars |");
console.log("|---|---|---|---|---|---|---|");
for (let sc = 0; sc < 3; sc++) for (let d = 0; d < 3; d++) {
  const acc = { f: [0, 0, 0], a: [0, 0, 0] };
  for (const seed of seeds) {
    sim.setCfg(sc, d, seed); sim.newRun(false); const r = sim.runs;
    for (let t = 0; t < 4200; t++) { sim.updateRun(r.fixed, 0.05); sim.updateRun(r.adaptive, 0.05); }
    for (const [k, run] of [["f", r.fixed], ["a", r.adaptive]]) { acc[k][0] += sim.averageWait(run); acc[k][1] += run.served; acc[k][2] += sim.totalQueue(run); }
  }
  for (const k of ["f", "a"]) { acc[k] = acc[k].map((v) => v / seeds.length); acc[k].forEach((v, i) => (tot[k][i] += v)); }
  tot.n++;
  console.log(`| ${names[sc]} / ${demands[d]} | ${f1(acc.f[0])}s | ${f1(acc.a[0])}s | ${f1(acc.f[1])} | ${f1(acc.a[1])} | ${Math.round((1 - acc.a[0] / acc.f[0]) * 100)}% | +${f1(acc.a[1] - acc.f[1])} |`);
}
const avg = (k, i) => tot[k][i] / tot.n;
console.log(`| **All 9 (average)** | ${f1(avg("f", 0))}s | ${f1(avg("a", 0))}s | ${f1(avg("f", 1))} | ${f1(avg("a", 1))} | ${Math.round((1 - avg("a", 0) / avg("f", 0)) * 100)}% | +${f1(avg("a", 1) - avg("f", 1))} |`);
console.log(`\nStill queued at end (average): fixed ${f1(avg("f", 2))}, adaptive ${f1(avg("a", 2))}`);
