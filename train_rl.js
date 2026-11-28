// Offline Q-learning trainer for the Flowstate adaptive controller.
// Usage: node train_rl.js [episodes]   -> writes rl-policy.js
// Runs the real simulator from script.js headlessly (no browser needed).
const fs = require("fs");

function loadSimulator(file) {
  let src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {}, querySelector: () => el(), getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  const els = {};
  global.document = { getElementById: (id) => els[id] || (els[id] = el()), addEventListener() {}, createElement: () => el(), querySelectorAll: () => [] };
  global.window = { requestAnimationFrame() {}, addEventListener() {} };
  src = src.replace("function draw() {\n    if (!runs) return;", "function draw() { return;");
  src = src.replace(/window\.requestAnimationFrame\(frame\);?\s*$/m, "");
  src = src.replace(/\}\)\(\);?\s*$/, "globalThis.__sim = { newRun, updateRun, averageWait, totalQueue, rlAgent, requestEmergency, get runs() { return runs; }, setRl(v) { rlEnabled = v; }, setMargin(m) { RL_SWITCH_MARGIN = m; }, RL_GAMMA, setCfg(s, d, sd) { scenarioIndex = s; demandIndex = d; seed = sd; } };\n})();");
  eval(src);
  return globalThis.__sim;
}

const sim = loadSimulator("script.js");
const greedy = sim.rlAgent.decide;
const EPISODES = Number(process.argv[2] || 3000);
const GAMMA = sim.RL_GAMMA;
const INIT = Number(process.env.INIT || 90); // optimistic start (rewards are positive) so every action gets tried
const PRIOR = Number(process.env.PRIOR || 0); // small prior against switching: each switch costs 3s of lost green
const EPS_MAX = Number(process.env.EPS_MAX || 0.4);
const EXPLORE_SWITCH = Number(process.env.EXPLORE_SWITCH || 0.67); // share of exploratory moves that try a switch
const ALPHA_MIN = 0.03;
const table = new Map();
const tableB = new Map();
const entryIn = (map, key) => { if (!map.has(key)) map.set(key, { q: [INIT, INIT - PRIOR, INIT - PRIOR], n: [0, 0, 0] }); return map.get(key); };
const entry = (key) => entryIn(table, key);

function exportPolicy(minVisits = 3) {
  const q = {};
  for (const [key, e] of table) {
    const b = tableB.get(key) || e;
    if (e.n.reduce((x, y) => x + y, 0) + b.n.reduce((x, y) => x + y, 0) >= minVisits) q[key] = e.q.slice(0, 2).map((v, i) => Math.round(((v + b.q[i]) / 2) * 100) / 100);
  }
  return { version: 1, algorithm: "tabular Q-learning (semi-MDP, gamma 0.98/s)", states: Object.keys(q).length, q };
}

function runEpisode(config, seed, adaptiveMode) {
  sim.setCfg(config[0], config[1], seed);
  sim.newRun(false);
  const run = sim.runs.adaptive;
  for (let t = 0; t < 4200; t += 1) sim.updateRun(run, 0.05);
  return run;
}

function evaluate(policy, seeds) {
  const results = { wait: 0, served: 0, left: 0, max: 0, n: 0 };
  for (const mode of ["rl"]) {
    window.FLOWSTATE_RL_POLICY = policy;
    sim.rlAgent.decide = greedy;
    sim.setRl(mode === "rl");
    for (let s = 0; s < 3; s += 1) for (let d = 0; d < 3; d += 1) for (const seed of seeds) {
      const run = runEpisode([s, d], seed);
      const waits = run.completedWaits.concat(["N", "E", "S", "W"].flatMap((k) => run.queues[k].map((v) => run.time - v.arrival)));
      results.wait += sim.averageWait(run); results.served += run.served; results.left += sim.totalQueue(run);
      results.max += Math.max(0, ...waits); results.n += 1;
    }
  }
  for (const k of ["wait", "served", "left", "max"]) results[k] /= results.n;
  return results;
}

function evaluateHeuristic(seeds) {
  window.FLOWSTATE_RL_POLICY = null;
  sim.rlAgent.decide = greedy;
  sim.setRl(false);
  const out = { wait: 0, served: 0, left: 0, max: 0, n: 0 };
  for (let s = 0; s < 3; s += 1) for (let d = 0; d < 3; d += 1) for (const seed of seeds) {
    const run = runEpisode([s, d], seed);
    const waits = run.completedWaits.concat(["N", "E", "S", "W"].flatMap((k) => run.queues[k].map((v) => run.time - v.arrival)));
    out.wait += sim.averageWait(run); out.served += run.served; out.left += sim.totalQueue(run); out.max += Math.max(0, ...waits); out.n += 1;
  }
  for (const k of ["wait", "served", "left", "max"]) out[k] /= out.n;
  return out;
}

const fmt = (r) => `wait ${r.wait.toFixed(2)}s  served ${r.served.toFixed(1)}  queued-at-end ${r.left.toFixed(1)}  longest ${r.max.toFixed(1)}s`;
if (require.main === module) {
  const validation = [101, 102, 103, 104];
  console.log("baseline heuristic (validation):", fmt(evaluateHeuristic(validation)));
  let best = { score: Infinity, policy: null };
  for (let episode = 0; episode < EPISODES; episode += 1) {
    const progress = episode / EPISODES;
    const epsilon = Math.max(0.02, EPS_MAX * (1 - progress / 0.8));
    sim.rlAgent.decide = (ctx) => {
      const { run, state, valid, elapsed, reward } = ctx;
      const e = entry(state);
      const eB = entryIn(tableB, state);
      if (run.rlPrev) {
        // Double Q-learning: one table picks the best next action, the other evaluates it (removes maximization bias).
        const p = run.rlPrev;
        const useA = Math.random() < 0.5;
        const [upd, other] = useA ? [table, tableB] : [tableB, table];
        const pe = entryIn(upd, p.state);
        const nextU = entryIn(upd, state);
        const nextO = entryIn(other, state);
        let arg = valid[0];
        for (const a of valid) if (nextU.q[a] > nextU.q[arg]) arg = a;
        const target = reward + Math.pow(GAMMA, elapsed) * nextO.q[arg];
        pe.n[p.a] += 1;
        const alpha = Math.max(ALPHA_MIN, 1 / (1 + 0.05 * pe.n[p.a]));
        pe.q[p.a] += alpha * (target - pe.q[p.a]);
      }
      const avg = (a) => e.q[a] + eB.q[a];
      let action;
      if (Math.random() < epsilon) action = Math.random() < EXPLORE_SWITCH ? valid[1 + Math.floor(Math.random() * (valid.length - 1))] : 0;
      else { action = valid[0]; for (const a of valid) if (avg(a) > avg(action) || (avg(a) === avg(action) && Math.random() < 0.5)) action = a; }
      run.rlPrev = { state, a: action };
      return action;
    };
    sim.setRl(true);
    window.FLOWSTATE_RL_POLICY = null;
    runEpisode([episode % 3, Math.floor(episode / 3) % 3], 1000 + episode);
    if ((episode + 1) % 250 === 0 || episode + 1 === EPISODES) {
      const policy = exportPolicy();
      const r = evaluate(policy, validation);
      const score = r.wait - 0.05 * r.served;
      if (score < best.score) best = { score, policy, episode: episode + 1, r };
      console.log(`ep ${episode + 1}  eps ${epsilon.toFixed(2)}  states ${policy.states}  ${fmt(r)}`);
    }
  }
  console.log(`best snapshot: episode ${best.episode}  ${fmt(best.r)}`);
  fs.writeFileSync("rl-policy.js", `// Generated by train_rl.js (tabular Q-learning). Safe to delete: the controller falls back to the heuristic.\nwindow.FLOWSTATE_RL_POLICY = ${JSON.stringify(best.policy)};\n`);
  console.log("wrote rl-policy.js", fs.statSync("rl-policy.js").size, "bytes");
}
module.exports = { loadSimulator, evaluate, evaluateHeuristic, fmt };
