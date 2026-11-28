// Random-search tuner for the adaptive cycle planner. Usage: node tune_planner.js [configs]
// Tunes on validation seeds, then reports the top candidates on separate test seeds.
const fs = require("fs");
const T = require("./sim_loader.js");
const base = fs.readFileSync("script.js", "utf8");
const space = {
  CYCLE_MIN_GREEN: [10],
  CYCLE_EXTEND_MIN_CARS: [1, 2, 3],
  CYCLE_ORDER_BY_NEED: [0, 1],
  CYCLE_LOOKAHEAD: [10, 15, 20, 30],
  CYCLE_START_UP: [2, 3, 4],
  CYCLE_EXTEND_STEP: [3, 5, 8, 12],
  CYCLE_GAP_OUT_AFTER: [2, 3, 5],
  GREEN_PER_VEHICLE: [1.1, 1.25, 1.4, 1.6],
  PREEMPT: [[3, 1]], // the requested rule: switch when another road has 3+ more cars
};
const defaults = { CYCLE_MIN_GREEN: 6, CYCLE_EXTEND_MIN_CARS: 2, CYCLE_ORDER_BY_NEED: 0, CYCLE_LOOKAHEAD: 20, CYCLE_START_UP: 4, CYCLE_EXTEND_STEP: 8, CYCLE_GAP_OUT_AFTER: 2, GREEN_PER_VEHICLE: 1.25, PREEMPT: [3, 1] };
function build(cfg) {
  let src = base;
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "PREEMPT") {
      src = src.replace(/PREEMPT_MIN_GAP = [0-9.e]+;/, `PREEMPT_MIN_GAP = ${v[0]};`).replace(/PREEMPT_RATIO = [0-9.e]+;/, `PREEMPT_RATIO = ${v[1]};`);
    } else src = src.replace(new RegExp(`${k} = [0-9.]+;`), `${k} = ${v};`);
  }
  fs.writeFileSync("_cfg.js", src);
  return T.loadSimulator("_cfg.js");
}
function evaluate(sim, seeds) {
  const out = { f: { w: 0, s: 0, q: 0 }, a: { w: 0, s: 0, q: 0, m: 0 }, n: 0, per: {} };
  for (let sc = 0; sc < 3; sc++) for (let d = 0; d < 3; d++) {
    const key = `${sc}-${d}`; out.per[key] = { fw: 0, fs: 0, aw: 0, as: 0, n: 0 };
    for (const seed of seeds) {
      sim.setCfg(sc, d, seed); sim.newRun(false); const r = sim.runs;
      for (let t = 0; t < 4200; t++) { sim.updateRun(r.fixed, 0.05); sim.updateRun(r.adaptive, 0.05); }
      const waits = r.adaptive.completedWaits.concat(["N","E","S","W"].flatMap((k) => r.adaptive.queues[k].map((v) => r.adaptive.time - v.arrival)));
      out.f.w += sim.averageWait(r.fixed); out.f.s += r.fixed.served; out.f.q += sim.totalQueue(r.fixed);
      out.a.w += sim.averageWait(r.adaptive); out.a.s += r.adaptive.served; out.a.q += sim.totalQueue(r.adaptive); out.a.m += Math.max(0, ...waits);
      const p = out.per[key]; p.fw += sim.averageWait(r.fixed); p.fs += r.fixed.served; p.aw += sim.averageWait(r.adaptive); p.as += r.adaptive.served; p.n++;
      out.n++;
    }
  }
  for (const g of ["f", "a"]) for (const k of Object.keys(out[g])) out[g][k] /= out.n;
  for (const p of Object.values(out.per)) for (const k of ["fw", "fs", "aw", "as"]) p[k] /= p.n;
  return out;
}
const score = (o) => o.a.w - 0.08 * o.a.s;
module.exports = { build, evaluate, defaults, score };
if (require.main === module) {
  const N = Number(process.argv[2] || 120);
  const val = [101, 102, 103, 104], test = [11, 12, 13, 14, 15, 16, 17, 18];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const results = [];
  const tryCfg = (cfg) => { const o = evaluate(build(cfg), val); results.push({ cfg, o, s: score(o) }); };
  tryCfg(defaults);
  for (let i = 0; i < N; i++) tryCfg(Object.fromEntries(Object.entries(space).map(([k, v]) => [k, pick(v)])));
  results.sort((a, b) => a.s - b.s);
  console.log("validation: default score", results.find((r) => r.cfg === defaults).s.toFixed(2), "best", results[0].s.toFixed(2));
  const top = results.slice(0, 5);
  const cands = [{ cfg: defaults, label: "current default" }, ...top.map((t, i) => ({ cfg: t.cfg, label: `top${i + 1}` }))];
  for (const c of cands) {
    const o = evaluate(build(c.cfg), test);
    console.log(c.label.padEnd(16), JSON.stringify(c.cfg), `| TEST wait ${o.a.w.toFixed(2)} served ${o.a.s.toFixed(1)} left ${o.a.q.toFixed(1)} longest ${o.a.m.toFixed(1)}`);
  }
  fs.writeFileSync("tune_result.json", JSON.stringify(top.map((t) => t.cfg)));
}
