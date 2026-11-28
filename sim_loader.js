// Loads script.js headlessly (no browser) so tests and tuners can run the real simulator.
const fs = require("fs");
function loadSimulator(file = "script.js") {
  let src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {}, querySelector: () => el(), getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  const els = {};
  global.document = { getElementById: (id) => els[id] || (els[id] = el()), addEventListener() {}, createElement: () => el(), querySelectorAll: () => [] };
  global.window = { requestAnimationFrame() {}, addEventListener() {} };
  src = src.replace("function draw() {\n    if (!runs) return;", "function draw() { return;");
  src = src.replace(/window\.requestAnimationFrame\(frame\);?\s*$/m, "");
  src = src.replace(/\}\)\(\);?\s*$/, "globalThis.__sim = { newRun, updateRun, averageWait, totalQueue, requestEmergency, get runs() { return runs; }, setCfg(s, d, sd) { scenarioIndex = s; demandIndex = d; seed = sd; } };\n})();");
  eval(src);
  return globalThis.__sim;
}
module.exports = { loadSimulator };
