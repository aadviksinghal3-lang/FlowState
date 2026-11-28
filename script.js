"use strict";

(() => {
  const DIRECTIONS = ["N", "E", "S", "W"];
  const PHASES = ["N", "E", "S", "W"]; // one signal per road, served one at a time
  const PHASE_DIRS = { N: ["N"], E: ["E"], S: ["S"], W: ["W"] };
  const SIM_DURATION = 210;
  const YELLOW_SECONDS = 3;
  const FIXED_RED_SECONDS = 60;
  const FIXED_GREEN = FIXED_RED_SECONDS / (PHASES.length - 1) - YELLOW_SECONDS; // 17s: each road is red for the other three roads' 20s slots
  const OPENING_EW_SURGE_VEHICLES = 20;
  const ADAPTIVE_MIN_GREEN = 6;
  const ADAPTIVE_NORMAL_SWITCH_GREEN = 10;
  const ADAPTIVE_MAX_GREEN = 30;
  const ADAPTIVE_HEAVY_MAX_GREEN = 60;
  const QUEUE_SWITCH_DIFFERENCE = 3;
  const QUEUE_SWITCH_CONFIRMATIONS = 4;
  const HEAVY_QUEUE_THRESHOLD = 10;
  const HEAVY_QUEUE_RATIO = 2;
  const CROSS_SECONDS = 2.2;
  const DISCHARGE_HEADWAY = 1.1;          // seconds between cars released from the same road on green
  const BURST_FIRST_TIME = 10;            // platoon bursts make queues visibly jump while a road is red
  const BURST_GAP_MIN = 14;
  const BURST_GAP_MAX = 24;
  const BURST_SIZE_MIN = 5;
  const BURST_SIZE_MAX = 9;
  const LEFT_TURN_SHARE = 0.2;
  const RIGHT_TURN_SHARE = 0.2;
  const CYCLE_GREEN_BUDGET = 60;          // total green seconds shared by all roads in one cycle
  const CYCLE_MIN_GREEN = 10;              // every road with cars gets at least this much green (or less if it needs less)
  const CYCLE_LOOKAHEAD = 10;             // seconds of expected arrivals added to a road's current queue
  const CYCLE_START_UP = 2;               // start-up loss at the beginning of a green
  const CYCLE_EXTEND_STEP = 12;            // extend a busy road's green in steps like 20s -> 25s
  const CYCLE_EXTEND_MIN_CARS = 1;        // a green is only extended if at least this many cars are still waiting
  const CYCLE_ORDER_BY_NEED = 1;          // 1 = serve the road with the biggest planned green first, 0 = N,E,S,W rotation
  const CYCLE_GAP_OUT_AFTER = 2;          // an emptied road ends its green early after this many seconds
  const CYCLE_EMERGENCY_GREEN = 8;
  const PREEMPT_MIN_GAP = 3;              // another road must have at least this many MORE cars (1-2 more or equal: keep green)...
  const PREEMPT_RATIO = 1;                // ...and at least this multiple of the green road's queue (1 = no extra condition)
  const PREEMPT_MIN_GREEN = 10;           // never switch because of a queue difference before this much green
  const PREEMPT_PERSIST = 0.5;            // ...for this many seconds before the green is cut short
  const EMPTY_STAT = { count: 0, wait: 0, max: 0, pressure: 0, rate: 0, predicted: 0 };
  // Vehicle paths in % of the intersection box. Each road has its own lane; cars drive on the right.
  const LANE_START = { N: [46, 27], S: [54, 71], W: [37, 54], E: [63, 46] };
  const LANE_END = { N: [46, 100], S: [54, 0], W: [100, 54], E: [0, 46] };
  const TURN_PATHS = {
    N: { right: { at: [46, 46], to: [0, 46] }, left: { at: [46, 54], to: [100, 54] } },
    S: { right: { at: [54, 54], to: [100, 54] }, left: { at: [54, 46], to: [0, 46] } },
    W: { right: { at: [46, 54], to: [46, 100] }, left: { at: [54, 54], to: [54, 0] } },
    E: { right: { at: [54, 46], to: [54, 0] }, left: { at: [46, 46], to: [46, 100] } },
  };
  const ADAPTIVE_FAIRNESS_WAIT = 60;      // any vehicle waiting this long wins the next safe switch (45 tested slightly worse)
  const RATE_WINDOW = 10;                 // seconds of recent arrivals used to estimate inflow
  const PREDICT_HORIZON = 6;              // look-ahead (s) for expected new arrivals
  const PREDICT_WEIGHT = 2;               // pressure points per expected arriving car
  const PRESSURE_SWITCH_MARGIN = 6;       // other phase must beat current by this much (= 3 cars) to justify a 3s yellow
  const GREEN_PER_VEHICLE = 1.1;          // approx seconds of green needed to discharge one queued car
  const DYNAMIC_GREEN_BASE = 4;           // buffer added to demand-based green
  const DYNAMIC_MIN_GREEN = 30;     // lower (e.g. 12) to let light traffic hand over green earlier; tested slightly worse
  const scenarios = [
    { name: "Morning rush", description: "North-south commuter flow", weights: [0.33, 0.16, 0.31, 0.20] },
    { name: "Balanced flow", description: "Balanced four-approach traffic flow", weights: [0.25, 0.25, 0.25, 0.25] },
    { name: "Event surge", description: "Event release with a short demand surge", weights: [0.22, 0.28, 0.22, 0.28] },
  ];
  const demands = [
    { name: "Low", rate: 0.10 },
    { name: "Medium", rate: 0.16 },
    { name: "High", rate: 0.24 },
  ];
  const $ = (id) => document.getElementById(id);
  let scenarioIndex = 0;
  let demandIndex = 1;
  let seed = 24;
  let speedIndex = 0;
  let speed = 1;
  let authorization = true;
  let paused = false;
  let hasStarted = false;
  let completed = false;
  let chartOpen = false;
  let lastFrame = 0;
  let runs;

  function seededRandom(seedValue) {
    let state = seedValue >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generateArrivals() {
    const random = seededRandom(seed);
    const turnRandom = seededRandom(seed * 7919 + 13);
    const pickTurn = () => {
      const value = turnRandom();
      return value < LEFT_TURN_SHARE ? "left" : value < LEFT_TURN_SHARE + RIGHT_TURN_SHARE ? "right" : "straight";
    };
    const arrivals = Array.from({ length: OPENING_EW_SURGE_VEHICLES }, (_, index) => ({
      time: 0,
      turn: pickTurn(),
      direction: index % 2 === 0 ? "E" : "W",
      id: `opening-ew-surge-${index}`,
    }));
    const scenario = scenarios[scenarioIndex];
    const rate = demands[demandIndex].rate;
    for (let index = 0; index < DIRECTIONS.length; index += 1) {
      let time = -Math.log(Math.max(0.000001, random())) / (rate * scenario.weights[index] * 2.9);
      while (time < SIM_DURATION) {
        const surge = scenarioIndex === 2 && time > 50 && time < 125 ? 2.1 : 1;
        arrivals.push({ time, turn: pickTurn(), direction: DIRECTIONS[index], id: `${index}-${arrivals.length}` });
        time += -Math.log(Math.max(0.000001, random())) / (rate * scenario.weights[index] * 2.9 * surge);
      }
    }
    // Platoon bursts: a group of cars reaches one road within a few seconds, shared by both controllers.
    const burstRandom = seededRandom(seed * 104729 + 7);
    let burstTime = BURST_FIRST_TIME;
    while (burstTime < SIM_DURATION - 5) {
      let pick = burstRandom();
      let burstIndex = 0;
      for (let index = 0; index < DIRECTIONS.length; index += 1) {
        pick -= scenario.weights[index];
        if (pick <= 0) { burstIndex = index; break; }
        burstIndex = index;
      }
      const size = BURST_SIZE_MIN + Math.floor(burstRandom() * (BURST_SIZE_MAX - BURST_SIZE_MIN + 1));
      let carTime = burstTime;
      for (let car = 0; car < size; car += 1) {
        arrivals.push({ time: carTime, turn: pickTurn(), direction: DIRECTIONS[burstIndex], id: `burst-${burstIndex}-${arrivals.length}` });
        carTime += 0.25 + burstRandom() * 0.45;
      }
      burstTime += BURST_GAP_MIN + burstRandom() * (BURST_GAP_MAX - BURST_GAP_MIN);
    }
    arrivals.sort((a, b) => a.time - b.time || a.direction.localeCompare(b.direction));
    return arrivals;
  }

  function createRun(kind, arrivals) {
    return {
      kind,
      time: 0,
      arrivalIndex: 0,
      queues: Object.fromEntries(DIRECTIONS.map((direction) => [direction, []])),
      moving: [],
      served: 0,
      completedWaits: [],
      maxQueue: 0,
      phase: kind === "fixed" ? PHASES[0] : null,
      stage: kind === "fixed" ? "green" : "no-demand",
      remaining: kind === "fixed" ? FIXED_GREEN : 0,
      signalChangeAt: kind === "fixed" ? 0 : null,
      phaseChanges: [],
      stageChanges: kind === "fixed" ? [0] : [],
      greenElapsed: 0,
      greenTarget: kind === "fixed" ? FIXED_GREEN : null,
      queueAdvantageChecks: 0,
      plan: null,
      extendedBy: 0,
      plannedGreen: 0,
      hop: false,
      preemptTime: 0,
      preemptions: 0,
      arrivalLog: [],
      pendingPhase: null,
      decision: kind === "fixed" ? "Fixed schedule: each road has its own signal: 17s green, 3s yellow, 60s red." : "Waiting for vehicles.",
      emergencyNotice: "",
      emergency: null,
      lastEmergencyWait: null,
      arrivals,
    };
  }

  function newRun(incrementSeed = true, startPaused = false) {
    if (incrementSeed) seed += 1;
    const arrivals = generateArrivals();
    runs = { fixed: createRun("fixed", arrivals), adaptive: createRun("adaptive", arrivals) };
    lastFrame = 0;
    paused = startPaused;
    hasStarted = !startPaused;
    completed = false;
    $("pause-button").textContent = "PAUSE";
    $("pause-button").disabled = startPaused;
    $("start-button").disabled = !startPaused;
    $("completion-banner").hidden = true;
    updateStaticLabels();
    draw();
  }

  function startSimulation() {
    if (completed || hasStarted) return;
    paused = false;
    hasStarted = true;
    lastFrame = 0;
    $("start-button").disabled = true;
    $("pause-button").disabled = false;
    draw();
  }

  function currentStats(run) {
    const result = Object.fromEntries(PHASES.map((phase) => [phase, { ...EMPTY_STAT }]));
    const cutoff = run.time - RATE_WINDOW;
    while (run.arrivalLog.length && run.arrivalLog[0].time < cutoff) run.arrivalLog.shift();
    const window = Math.min(RATE_WINDOW, Math.max(run.time, 1));
    for (const direction of DIRECTIONS) {
      const phase = phaseFor(direction);
      for (const vehicle of run.queues[direction]) {
        const wait = Math.max(0, run.time - vehicle.arrival);
        result[phase].count += 1;
        result[phase].wait += wait;
        result[phase].max = Math.max(result[phase].max, wait);
      }
    }
    for (const entry of run.arrivalLog) result[entry.phase].rate += 1 / window;
    for (const phase of PHASES) {
      const stat = result[phase];
      stat.predicted = stat.rate * PREDICT_HORIZON;
      // Pressure = 2N + W/30 + expected arrivals in the next few seconds.
      stat.pressure = stat.count ? 2 * stat.count + stat.wait / 30 + PREDICT_WEIGHT * stat.predicted : 0;
    }
    return result;
  }

  function phaseFor(direction) {
    return direction;
  }

  function startGreen(run, phase, reason, stats) {
    const previousPhase = run.phase;
    const previousStage = run.stage;
    run.phase = phase;
    if (previousPhase && previousPhase !== phase) {
      run.signalChangeAt = run.time;
      run.phaseChanges.push(run.time);
    }
    run.stage = "green";
    if (previousStage !== "green") {
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
    }
    run.greenElapsed = 0;
    run.greenTarget = run.kind === "fixed" ? FIXED_GREEN : ADAPTIVE_MAX_GREEN;
    run.remaining = run.greenTarget;
    run.queueAdvantageChecks = 0;
    run.pendingPhase = null;
    run.decision = reason;
    if (run.emergency && run.emergency.authorized && phaseFor(run.emergency.direction) === phase) {
      run.lastEmergencyWait = Math.max(0, run.time - run.emergency.requestedAt);
      run.decision = `Emergency priority granted after ${run.lastEmergencyWait.toFixed(1)}s.`;
      run.emergency = null;
    }
  }

  function arrive(run) {
    while (run.arrivalIndex < run.arrivals.length && run.arrivals[run.arrivalIndex].time <= run.time) {
      const arrival = run.arrivals[run.arrivalIndex++];
      run.queues[arrival.direction].push({ ...arrival, arrival: arrival.time, emergency: false });
      // The shared opening surge is a one-off, so it is not treated as an ongoing inflow rate.
      if (!String(arrival.id).startsWith("opening")) run.arrivalLog.push({ time: arrival.time, phase: phaseFor(arrival.direction) });
    }
  }

  function serve(run, dt) {
    if (run.stage !== "green" || !run.phase) return;
    for (const direction of PHASE_DIRS[run.phase]) {
      const queue = run.queues[direction];
      if (queue.length && !run.moving.some((vehicle) => vehicle.direction === direction && vehicle.moving < DISCHARGE_HEADWAY)) {
        const vehicle = queue.shift();
        vehicle.wait = Math.max(0, run.time - vehicle.arrival);
        run.completedWaits.push(vehicle.wait);
        const profile = crossingProfile(run, direction, vehicle.turn || "straight");
        run.moving.push({
          ...vehicle,
          moving: 0,
          crossingDuration: profile.duration,
          box: profile.box,
        });
      }
    }
  }

  function vehiclePath(direction, turn) {
    const start = LANE_START[direction];
    if (turn === "left" || turn === "right") {
      const route = TURN_PATHS[direction][turn];
      return [start, route.at, route.to];
    }
    return [start, LANE_END[direction]];
  }

  function pathLength(points, width, height) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot((points[i][0] - points[i - 1][0]) * width / 100, (points[i][1] - points[i - 1][1]) * height / 100);
    }
    return total;
  }

  function pathPose(points, progress, box) {
    const width = box ? box.w : 2;
    const height = box ? box.h : 1;
    const lengths = [];
    for (let i = 1; i < points.length; i += 1) lengths.push(pathLength([points[i - 1], points[i]], width, height));
    let remaining = progress * lengths.reduce((sum, value) => sum + value, 0);
    let segment = 0;
    while (segment < lengths.length - 1 && remaining > lengths[segment]) {
      remaining -= lengths[segment];
      segment += 1;
    }
    const [a, b] = [points[segment], points[segment + 1]];
    const fraction = lengths[segment] ? Math.min(1, remaining / lengths[segment]) : 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const heading = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "east" : "west") : (dy > 0 ? "south" : "north");
    return { left: a[0] + dx * fraction, top: a[1] + dy * fraction, heading, turned: segment > 0 };
  }

  function crossingProfile(run, direction, turn) {
    const intersection = $(`${run.kind}-intersection`);
    let width = 0;
    let height = 0;
    if (typeof intersection.getBoundingClientRect === "function") ({ width, height } = intersection.getBoundingClientRect());
    const known = Boolean(width && height);
    const box = known ? { w: width, h: height } : { w: 2, h: 1 };
    const straight = pathLength(vehiclePath(direction, "straight"), box.w, box.h);
    const length = pathLength(vehiclePath(direction, turn), box.w, box.h);
    const base = known ? CROSS_SECONDS * straight / (width * 0.48) : CROSS_SECONDS;
    // Cap so a turning car always clears the junction within the 3s yellow.
    return { box, duration: Math.min(base * length / straight, YELLOW_SECONDS - 0.2) };
  }

  function tickFixed(run, dt, stats) {
    if (run.stage === "green") run.greenElapsed += dt;
    run.remaining = Math.max(0, run.remaining - dt);
    if (run.stage === "green" && run.remaining <= 0.000001) {
      run.stage = "yellow";
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.remaining = YELLOW_SECONDS;
      run.decision = `Fixed plan: ${run.phase} road yellow clearance.`;
    } else if (run.stage === "yellow" && run.remaining <= 0.000001) {
      run.phase = PHASES[(PHASES.indexOf(run.phase) + 1) % PHASES.length];
      run.signalChangeAt = run.time;
      run.phaseChanges.push(run.time);
      run.stageChanges.push(run.time);
      run.stage = "green";
      run.remaining = FIXED_GREEN;
      run.greenTarget = FIXED_GREEN;
      run.greenElapsed = 0;
      run.decision = `Fixed schedule: ${run.phase} road is green; the other three roads stay red.`;
    }
  }


  // ---- Demand-based cycle planner ------------------------------------------------------------
  // Each cycle the busy roads share at most 60 green seconds in proportion to their queues plus
  // expected arrivals. Roads with no cars get no green. Busy roads can be extended in 5s steps
  // (e.g. 20s -> 25s) from time that other roads did not need, and every road with cars still gets a turn.
  function allocateGreens(order, need) {
    const green = {};
    let budget = CYCLE_GREEN_BUDGET;
    for (const phase of order) {
      green[phase] = Math.min(need[phase], CYCLE_MIN_GREEN);
      budget -= green[phase];
    }
    for (let pass = 0; pass < 6 && budget > 0.01; pass += 1) {
      const unmet = order.map((phase) => Math.max(0, need[phase] - green[phase]));
      const totalUnmet = unmet.reduce((sum, value) => sum + value, 0);
      if (totalUnmet <= 0.01) break;
      const pool = budget;
      order.forEach((phase, index) => {
        const give = Math.min(unmet[index], pool * unmet[index] / totalUnmet);
        green[phase] += give;
        budget -= give;
      });
    }
    for (const phase of order) green[phase] = Math.max(4, Math.floor(green[phase]));
    return green;
  }

  function makePlan(stats, afterPhase, firstPhase) {
    const start = firstPhase ? PHASES.indexOf(firstPhase) : afterPhase ? (PHASES.indexOf(afterPhase) + 1) % PHASES.length : 0;
    const order = PHASES.map((_, i) => PHASES[(start + i) % PHASES.length]).filter((phase) => stats[phase].count > 0);
    const need = {};
    for (const phase of order) need[phase] = GREEN_PER_VEHICLE * (stats[phase].count + stats[phase].rate * CYCLE_LOOKAHEAD) + CYCLE_START_UP;
    if (CYCLE_ORDER_BY_NEED) {
      const head = firstPhase ? order.splice(0, 1) : [];
      order.sort((a, b) => need[b] - need[a]);
      order.unshift(...head);
    }
    return { order, greens: allocateGreens(order, need), index: 0 };
  }

  const planTotal = (plan) => plan.order.reduce((sum, phase) => sum + plan.greens[phase], 0);

  function nextPlanned(run, stats, afterPhase) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!run.plan || run.plan.index >= run.plan.order.length) run.plan = makePlan(stats, afterPhase);
      while (run.plan.index < run.plan.order.length) {
        const phase = run.plan.order[run.plan.index];
        if (stats[phase].count > 0) return phase;
        run.plan.greens[phase] = 0; // empty road: no green, its time goes back to the shared pool
        run.plan.index += 1;
      }
    }
    return null;
  }

  function planText(plan) {
    const parts = PHASES.map((phase) => (plan.order.includes(phase) && plan.greens[phase] > 0 ? `${phase} ${plan.greens[phase]}s` : `${phase} skipped`));
    return `${parts.join(" · ")} (${planTotal(plan)}/${CYCLE_GREEN_BUDGET}s)`;
  }

  function startCycleGreen(run, phase, stats, reason, hop) {
    startGreen(run, phase, reason, stats);
    run.hop = hop;
    run.extendedBy = 0;
    const seconds = hop ? CYCLE_EMERGENCY_GREEN : run.plan.greens[phase];
    run.plannedGreen = seconds;
    run.greenTarget = seconds;
    run.remaining = seconds;
    if (!hop) run.decision = `${reason} ${phase} gets ${seconds}s green.`;
  }

  function cycleRedTime(run, stats, target) {
    if (run.stage === "no-demand" || !run.plan || stats[target].count === 0) return null;
    const plan = run.plan;
    let time = run.stage === "green" ? run.remaining + YELLOW_SECONDS : run.remaining;
    const upcoming = plan.order.slice(run.stage === "green" ? plan.index + 1 : plan.index).filter((phase) => stats[phase].count > 0);
    for (const phase of upcoming) {
      if (phase === target) return time;
      time += plan.greens[phase] + YELLOW_SECONDS;
    }
    const last = plan.order[plan.order.length - 1] || run.phase;
    const next = makePlan(stats, last);
    for (const phase of next.order) {
      if (phase === target) return time;
      time += next.greens[phase] + YELLOW_SECONDS;
    }
    return time;
  }

  function tickCycle(run, dt, stats) {
    const idle = () => {
      run.phase = null;
      run.stage = "no-demand";
      run.remaining = 0;
      run.greenTarget = null;
      run.plan = null;
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.decision = "No cars on any road; signals idle and no green given.";
    };
    if (run.stage === "no-demand") {
      const first = nextPlanned(run, stats, null);
      if (first) startCycleGreen(run, first, stats, `Cycle plan: ${planText(run.plan)}.`, false);
      return;
    }
    if (run.stage === "yellow") {
      // An authorized emergency request that arrives during a yellow takes the next green.
      const urgent = run.emergency && run.emergency.authorized ? phaseFor(run.emergency.direction) : null;
      if (urgent && urgent !== run.pendingPhase && !run.hop) {
        run.pendingPhase = urgent;
        run.hop = true;
        run.decision = `Emergency request from ${urgent}; it gets the next green.`;
      }
      run.remaining = Math.max(0, run.remaining - dt);
      if (run.remaining > 0.000001) return;
      if (run.pendingPhase && run.hop) {
        startCycleGreen(run, run.pendingPhase, stats, "Emergency priority green.", true);
        return;
      }
      const target = nextPlanned(run, stats, run.phase);
      if (target) startCycleGreen(run, target, stats, run.plan.index === 0 ? `New cycle plan: ${planText(run.plan)}.` : `Next in cycle (${planTotal(run.plan)}/${CYCLE_GREEN_BUDGET}s).`, false);
      else idle();
      return;
    }
    if (!PHASES.some((phase) => stats[phase].count > 0) && run.moving.length === 0) {
      idle();
      return;
    }
    run.greenElapsed += dt;
    run.remaining = Math.max(0, run.remaining - dt);
    const current = run.phase;
    const plan = run.plan;
    const emergencyPhase = run.emergency && run.emergency.authorized ? phaseFor(run.emergency.direction) : null;
    const beginYellow = (target, hop, reason) => {
      run.stage = "yellow";
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.remaining = YELLOW_SECONDS;
      run.pendingPhase = target;
      run.hop = hop;
      run.decision = reason;
    };
    if (emergencyPhase === current) {
      run.emergency = null;
      run.remaining = Math.max(run.remaining, 3);
      run.decision = `Emergency vehicle is on the green road (${current}); keeping green until it clears.`;
      return;
    }
    if (emergencyPhase && !run.hop && run.greenElapsed >= ADAPTIVE_MIN_GREEN) {
      beginYellow(emergencyPhase, true, `Emergency request from ${emergencyPhase}; ending ${current} green after yellow.`);
      return;
    }
    if (run.hop) {
      if (run.remaining <= 0.000001) {
        const resume = nextPlanned(run, stats, current);
        if (resume && resume !== current) beginYellow(resume, false, `Emergency done; resuming cycle with ${resume}.`);
        else if (!resume) idle();
        else startCycleGreen(run, current, stats, "Emergency done; continuing.", false);
      }
      return;
    }
    const cars = stats[current].count;
    // Preemption: if another road has far more cars, cut this green short (yellow first) even though
    // some cars here are still waiting. They stay in the queue and get a turn in the new cycle.
    let rival = null;
    if (run.greenElapsed >= PREEMPT_MIN_GREEN) {
      for (const phase of PHASES) {
        if (phase === current) continue;
        const count = stats[phase].count;
        if (count - cars >= PREEMPT_MIN_GAP && count >= PREEMPT_RATIO * cars && (!rival || count > stats[rival].count)) rival = phase;
      }
    }
    run.preemptTime = rival ? run.preemptTime + dt : 0;
    if (rival && run.preemptTime >= PREEMPT_PERSIST) {
      run.preemptTime = 0;
      run.preemptions += 1;
      plan.greens[current] = Math.max(1, Math.round(run.greenElapsed));
      run.plan = makePlan(stats, current, rival);
      beginYellow(rival, false, `${rival} has ${stats[rival].count} cars vs ${cars} on ${current}: ${current} green cut short (yellow, then ${rival} green) although ${current} is not clear.`);
      return;
    }
    let finish = null;
    if (cars === 0 && run.greenElapsed >= CYCLE_GAP_OUT_AFTER && run.remaining > 0) {
      const saved = Math.round(run.remaining);
      plan.greens[current] = Math.max(1, Math.round(run.greenElapsed));
      finish = `${current} has no more cars: green ended early, ${saved}s returned to the other roads.`;
    } else if (run.remaining <= 0.000001) {
      const spare = CYCLE_GREEN_BUDGET - planTotal(plan);
      if (cars >= CYCLE_EXTEND_MIN_CARS && spare >= 1) {
        const extra = Math.min(CYCLE_EXTEND_STEP, Math.floor(spare));
        const before = plan.greens[current];
        plan.greens[current] += extra;
        run.extendedBy += extra;
        run.remaining += extra;
        run.greenTarget = plan.greens[current];
        const waiting = plan.order.slice(plan.index + 1).filter((phase) => stats[phase].count > 0);
        run.decision = `${current} still has ${cars} cars: green extended ${before}s → ${plan.greens[current]}s (cycle ${planTotal(plan)}/${CYCLE_GREEN_BUDGET}s).${waiting.length ? ` Red time +${extra}s on ${waiting.join(", ")}.` : ""}`;
        return;
      }
      finish = `${current} green finished (${plan.greens[current]}s planned).`;
    }
    if (!finish) return;
    plan.index += 1;
    const next = nextPlanned(run, stats, current);
    if (!next) return; // nothing waiting: the idle check above ends the green once crossings finish
    if (next === current) {
      // Only this road has cars: start its next cycle without a pointless yellow.
      run.greenElapsed = 0;
      run.extendedBy = 0;
      run.plannedGreen = plan.greens[current];
      run.greenTarget = run.plannedGreen;
      run.remaining = run.plannedGreen;
      run.decision = `${finish} No other road has cars, so ${current} continues for ${run.plannedGreen}s.`;
      return;
    }
    beginYellow(next, false, `${finish} Next: ${next}.`);
  }

  function updateRun(run, dt) {
    if (run.time >= SIM_DURATION && run.arrivalIndex >= run.arrivals.length && !run.moving.length && totalQueue(run) === 0) return;
    const steps = Math.max(1, Math.ceil(dt / 0.05));
    const step = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      run.time += step;
      arrive(run);
      const stats = currentStats(run);
      if (run.kind === "fixed") tickFixed(run, step, stats);
      else tickCycle(run, step, stats);
      serve(run, step);
      for (const vehicle of run.moving) vehicle.moving += step;
      const completed = run.moving.filter((vehicle) => vehicle.moving >= (vehicle.crossingDuration || CROSS_SECONDS));
      completed.forEach((vehicle) => {
        if (vehicle.emergency) run.lastEmergencyWait = vehicle.wait;
      });
      run.moving = run.moving.filter(
        (vehicle) => vehicle.moving < (vehicle.crossingDuration || CROSS_SECONDS),
      );
      run.served += completed.length;
      run.maxQueue = Math.max(run.maxQueue, totalQueue(run));
    }
  }

  function totalQueue(run) {
    return DIRECTIONS.reduce((sum, direction) => sum + run.queues[direction].length, 0);
  }

  function runComplete(run) {
    return run.time >= SIM_DURATION
      && run.arrivalIndex >= run.arrivals.length
      && run.moving.length === 0
      && totalQueue(run) === 0;
  }

  function averageWait(run) {
    const waits = run.completedWaits;
    const waiting = run.queues ? DIRECTIONS.flatMap((direction) => run.queues[direction].map((vehicle) => run.time - vehicle.arrival)) : [];
    const count = waits.length + waiting.length;
    if (!count) return 0;
    return (waits.reduce((sum, wait) => sum + wait, 0) + waiting.reduce((sum, wait) => sum + wait, 0)) / count;
  }

  function maxWait(run, phase) {
    const values = PHASE_DIRS[phase].flatMap((direction) => run.queues[direction].map((vehicle) => run.time - vehicle.arrival));
    return values.length ? Math.max(...values) : 0;
  }

  function renderIntersection(run, root) {
    const stats = run.kind === "adaptive" ? currentStats(run) : null;
    root.replaceChildren();
    const landscape = document.createElement("div");
    landscape.className = "landscape";
    for (let i = 0; i < 4; i += 1) {
      const plot = document.createElement("div");
      plot.className = "plot";
      landscape.append(plot);
    }
    for (const className of ["tree one", "tree two", "tree three", "tree four"]) {
      const tree = document.createElement("span");
      tree.className = `tree ${className.split(" ")[1]}`;
      landscape.append(tree);
    }
    for (const className of [
      "building northwest",
      "building northeast",
      "building southwest",
      "building southeast",
      "shrub northwest",
      "shrub northeast",
      "shrub southwest",
      "shrub southeast",
      "bench northwest",
      "bench southeast",
      "pedestrian northeast",
      "pedestrian southwest",
    ]) {
      const decoration = document.createElement("span");
      decoration.className = `surrounding ${className}`;
      decoration.setAttribute("aria-hidden", "true");
      landscape.append(decoration);
    }
    root.append(landscape);

    for (const [direction, className] of [["N", "n"], ["E", "e"], ["S", "s"], ["W", "w"]]) {
      const label = document.createElement("span");
      label.className = `direction-label ${className}`;
      label.textContent = direction;
      root.append(label);
    }
    for (const className of ["road-h", "road-v", "lane-mark h", "lane-mark v", "stop-line n", "stop-line s", "stop-line e", "stop-line w"]) {
      const element = document.createElement("span");
      element.className = className;
      root.append(element);
    }
    for (const direction of DIRECTIONS) {
      const light = document.createElement("div");
      light.className = `traffic-signal ${direction.toLowerCase()}`;
      light.dataset.direction = direction;
      light.innerHTML = '<i class="lamp"></i><i class="lamp"></i><i class="lamp"></i>';
      const countdown = document.createElement("span");
      const signalPhase = phaseFor(direction);
      if (run.kind === "fixed" && run.stage !== "no-demand" && signalPhase !== run.phase) {
        const slotsAhead = (PHASES.indexOf(signalPhase) - PHASES.indexOf(run.phase) + PHASES.length) % PHASES.length - 1;
        const untilGreen = (run.stage === "green" ? run.remaining + YELLOW_SECONDS : run.remaining)
          + slotsAhead * (FIXED_GREEN + YELLOW_SECONDS);
        countdown.className = "signal-countdown red";
        countdown.textContent = `RED ${untilGreen.toFixed(1)}s`;
      } else if (run.kind === "adaptive" && run.stage !== "no-demand" && signalPhase !== run.phase) {
        const until = cycleRedTime(run, stats, signalPhase);
        countdown.className = "signal-countdown red";
        countdown.textContent = until === null ? "RED NO CARS" : `RED ${until.toFixed(1)}s`;
      } else if (signalPhase === run.phase && run.stage !== "no-demand") {
        countdown.className = `signal-countdown ${run.stage}`;
        countdown.textContent = run.stage === "yellow"
          ? `${run.remaining.toFixed(1)}s`
          : run.kind === "adaptive"
            ? `GREEN ${run.remaining.toFixed(1)}s${run.extendedBy ? ` (+${run.extendedBy})` : ""}`
            : `${run.remaining.toFixed(1)}s`;
      } else {
        countdown.className = `signal-countdown ${run.stage}`;
        countdown.hidden = true;
      }
      light.append(countdown);
      root.append(light);
    }
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Waiting for vehicles";
    root.append(empty);

    const activeVehicles = [];
    for (const direction of DIRECTIONS) {
      const queue = run.queues[direction];
      queue.slice(0, 9).forEach((vehicle, index) => {
        activeVehicles.push({ direction, index, vehicle, moving: false });
      });
    }
    run.moving.forEach((vehicle) => activeVehicles.push({ direction: vehicle.direction, index: 0, vehicle, moving: true }));
    activeVehicles.forEach(({ direction, index, vehicle, moving: isMoving }) => {
      const car = document.createElement("span");
      const turn = vehicle.turn || "straight";
      let heading = { N: "south", S: "north", W: "east", E: "west" }[direction];
      let pose = null;
      if (isMoving) {
        const progress = Math.min(1, vehicle.moving / (vehicle.crossingDuration || CROSS_SECONDS));
        pose = pathPose(vehiclePath(direction, turn), progress, vehicle.box);
        heading = pose.heading;
      }
      const vertical = heading === "north" || heading === "south";
      const showTurnLamp = turn !== "straight" && !(pose && pose.turned);
      car.className = `car heading-${heading} ${vertical ? "vertical" : ""} ${vehicle.emergency ? "emergency" : ""}${showTurnLamp ? ` turn-${turn}` : ""}`;
      const window = document.createElement("span");
      window.className = "car-window";
      const headlights = document.createElement("span");
      headlights.className = "car-lights headlights";
      const taillights = document.createElement("span");
      taillights.className = "car-lights taillights";
      car.append(window, headlights, taillights);
      if (showTurnLamp) {
        const turnLamp = document.createElement("span");
        turnLamp.className = "car-turn";
        car.append(turnLamp);
      }
      placeCar(car, direction, index, vehicle, isMoving, pose);
      root.append(car);
    });
    for (const direction of DIRECTIONS) {
      const hiddenCount = run.queues[direction].length - 9;
      if (hiddenCount <= 0) continue;
      const overflow = document.createElement("span");
      overflow.className = `queue-overflow ${direction.toLowerCase()}`;
      overflow.textContent = `+${hiddenCount}`;
      root.append(overflow);
    }
    const queuePresent = totalQueue(run) > 0 || run.moving.length > 0;
    empty.hidden = queuePresent;

    root.querySelectorAll(".traffic-signal").forEach((signal) => {
      const direction = signal.dataset.direction;
      const lamps = signal.querySelectorAll(".lamp");
      let active = -1;
      if (run.stage === "yellow" && phaseFor(direction) === run.phase) active = 1;
      else if (run.stage === "green" && phaseFor(direction) === run.phase) active = 2;
      else if (run.stage === "green" || run.stage === "yellow") active = 0;
      lamps.forEach((lamp, index) => {
        lamp.className = `lamp${index === active ? ` active-${active === 0 ? "red" : active === 1 ? "yellow" : "green"}` : ""}`;
      });
    });
  }

  function placeCar(car, direction, index, vehicle, moving, pose) {
    if (moving && pose) {
      car.style.left = `${pose.left}%`;
      car.style.top = `${pose.top}%`;
      car.style.opacity = String(0.65 + 0.35 * Math.min(1, vehicle.moving / (vehicle.crossingDuration || CROSS_SECONDS)));
      return;
    }
    const progress = moving
      ? Math.min(1, vehicle.moving / (vehicle.crossingDuration || CROSS_SECONDS))
      : 0;
    const q = Math.min(index, 8);
    if (direction === "N") {
      car.style.left = `${46 - (moving ? 0 : 4)}%`;
      car.style.top = moving ? `${27 + progress * 73}%` : `${Math.max(4, 29 - q * 7)}%`;
    } else if (direction === "S") {
      car.style.left = `${54 + (moving ? 0 : 4)}%`;
      car.style.top = moving ? `${71 - progress * 71}%` : `${Math.min(88, 69 + q * 7)}%`;
    } else if (direction === "W") {
      car.style.left = moving ? `${37 + progress * 63}%` : `${Math.max(2, 37 - q * 6)}%`;
      car.style.top = `${54 + (moving ? 0 : 4)}%`;
    } else {
      car.style.left = moving ? `${63 - progress * 63}%` : `${Math.min(88, 63 + q * 6)}%`;
      car.style.top = `${46 - (moving ? 0 : 4)}%`;
    }
    if (moving) car.style.opacity = String(0.65 + 0.35 * progress);
  }

  function formatTime(seconds) {
    const value = Math.floor(seconds);
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }

  function phaseLabel(run) {
    return run.phase ? `${run.phase}` : "NO DEMAND";
  }

  function statusColor(run) {
    if (run.stage === "yellow") return "yellow";
    if (run.stage === "no-demand") return "neutral";
    return "";
  }

  function renderRun(run) {
    const prefix = run.kind;
    const stats = currentStats(run);
    const card = $(`${prefix}-card`);
    const intersection = $(`${prefix}-intersection`);
    renderIntersection(run, intersection);
    $(`${prefix}-stats`).innerHTML = PHASES.map((phase) => {
      const stat = stats[phase];
      const signal = run.stage !== "no-demand" && run.phase === phase ? run.stage : "red";
      return `<div class="approach-stat ${signal}"><span>${phase}</span><strong>${stat.count} cars</strong><em>P ${stat.pressure.toFixed(1)} · IN ${(stat.rate * 60).toFixed(0)}/m · M ${maxWait(run, phase).toFixed(0)}s</em></div>`;
    }).join("");
    const badge = $(`${prefix}-badge`);
    badge.className = `signal-badge ${statusColor(run)}`;
    badge.querySelector("span:last-child").textContent = run.stage === "no-demand" ? "NO DEMAND" : `${phaseLabel(run)} ${run.stage.toUpperCase()}`;
    const status = $(`${prefix}-status`);
    status.className = `system-status ${statusColor(run)}`;
    status.textContent = run.stage === "green"
      ? `${phaseLabel(run)} GREEN  |  ${run.greenElapsed.toFixed(1)}s ELAPSED  |  TARGET ${Math.round(run.greenTarget)}s`
      : run.stage === "yellow"
        ? `${phaseLabel(run)} YELLOW CLEARANCE`
        : "NO DEMAND  |  Waiting for vehicles";
    $(`${prefix}-decision`).textContent = run.emergencyNotice
      ? `${run.decision} ${run.emergencyNotice}`
      : run.decision;
    $(`${prefix}-cleared`).textContent = String(run.served);
    $(`${prefix}-wait`).textContent = `${averageWait(run).toFixed(1)}s`;
    $(`${prefix}-queue`).textContent = `${totalQueue(run)} cars / ${Math.floor(run.time / 60)}m`;
    $(`${prefix}-emergency-wait`).textContent = run.lastEmergencyWait === null ? "--" : `${run.lastEmergencyWait.toFixed(1)}s`;
    $(`${prefix}-progress`).style.width = `${Math.min(100, run.time / SIM_DURATION * 100)}%`;
    $(`${prefix}-time`).textContent = `${formatTime(run.time)} / 03:30`;
    $(`${prefix}-summary`).textContent = `PEAK ${run.maxQueue} cars | MAX WAIT ${PHASES.map((phase) => `${phase} ${maxWait(run, phase).toFixed(0)}s`).join("  ")}`;
    card.dataset.stage = run.stage;
  }

  function draw() {
    if (!runs) return;
    renderRun(runs.fixed);
    renderRun(runs.adaptive);
    $("run-status").textContent = completed ? "COMPLETE" : !hasStarted ? "READY" : paused ? "PAUSED" : "LIVE";
    $("completion-banner").hidden = !completed;
    $("run-meta").textContent = `SHARED ARRIVALS / 210s  |  SEED ${seed}`;
    if (chartOpen) drawCharts();
  }

  function drawBarChart(root, fixedValue, adaptiveValue, formatter) {
    const maximum = Math.max(1, fixedValue, adaptiveValue);
    root.innerHTML = "";
    for (const [label, value, className] of [["FIXED", fixedValue, "fixed"], ["ADAPTIVE", adaptiveValue, "adaptive"]]) {
      const wrap = document.createElement("div");
      wrap.className = "bar-wrap";
      const valueLabel = document.createElement("span");
      valueLabel.className = "bar-value";
      valueLabel.textContent = formatter(value);
      const bar = document.createElement("span");
      bar.className = `bar ${className}`;
      bar.style.height = `${Math.max(1, value / maximum * 82)}%`;
      const caption = document.createElement("span");
      caption.className = `bar-label ${className}`;
      caption.textContent = label;
      wrap.append(valueLabel, bar, caption);
      root.append(wrap);
    }
  }

  function drawCharts() {
    const chartSnapshot = {
      fixed: { served: runs.fixed.served, wait: averageWait(runs.fixed) },
      adaptive: { served: runs.adaptive.served, wait: averageWait(runs.adaptive) },
    };
    drawBarChart(
      $("cleared-chart"),
      chartSnapshot.fixed.served,
      chartSnapshot.adaptive.served,
      (value) => String(Math.round(value)),
    );
    const fixedWait = chartSnapshot.fixed.wait;
    const adaptiveWait = chartSnapshot.adaptive.wait;
    drawBarChart($("wait-chart"), fixedWait, adaptiveWait, (value) => `${value.toFixed(1)}s`);
    $("wait-result").textContent = adaptiveWait < fixedWait
      ? "LOWER WAIT: ADAPTIVE"
      : fixedWait < adaptiveWait ? "LOWER WAIT: FIXED" : "WAIT: TIED";
    $("wait-result").style.color = adaptiveWait < fixedWait ? "var(--green)" : fixedWait < adaptiveWait ? "var(--cyan)" : "var(--muted)";
  }

  function updateStaticLabels() {
    $("scenario-button").innerHTML = `SCENARIO&nbsp; ${scenarios[scenarioIndex].name.toUpperCase()}`;
    $("demand-button").innerHTML = `DEMAND&nbsp; ${demands[demandIndex].name.toUpperCase()}`;
    $("scenario-description").textContent = `20-car E-W opening surge · platoon bursts · ${scenarios[scenarioIndex].description}`;
    $("run-meta").textContent = `SHARED ARRIVALS / 210s  |  SEED ${seed}`;
  }

  function requestEmergency() {
    if (completed) return;
    const direction = DIRECTIONS[(seed + 1) % DIRECTIONS.length];
    for (const run of [runs.fixed, runs.adaptive]) {
      const vehicle = { id: `emergency-${seed}-${run.kind}`, direction, arrival: run.time, emergency: true };
      if (authorization) {
        run.queues[direction].unshift(vehicle);
        run.emergency = { direction, requestedAt: run.time, authorized: true };
        run.emergencyNotice = `Authorized ${direction} request.`;
        run.decision = `Authorized emergency request from ${direction}; priority requested.`;
      } else {
        run.emergencyNotice = `Unauthorized emergency request from ${direction} denied.`;
        run.decision = `Unauthorized emergency request from ${direction} denied.`;
      }
    }
    draw();
  }

  function frame(timestamp) {
    if (lastFrame === 0) lastFrame = timestamp;
    const elapsed = Math.min(0.05, (timestamp - lastFrame) / 1000);
    lastFrame = timestamp;
    if (!paused && !completed && runs) {
      const dt = Math.min(elapsed * speed, Math.max(0, SIM_DURATION - runs.fixed.time));
      updateRun(runs.fixed, dt);
      updateRun(runs.adaptive, dt);
      if (runs.fixed.time >= SIM_DURATION) {
        completed = true;
        paused = true;
        $("pause-button").textContent = "COMPLETE";
        $("pause-button").disabled = true;
      }
    }
    draw();
    window.requestAnimationFrame(frame);
  }

  $("scenario-button").addEventListener("click", () => {
    scenarioIndex = (scenarioIndex + 1) % scenarios.length;
    newRun(false);
  });
  $("demand-button").addEventListener("click", () => {
    demandIndex = (demandIndex + 1) % demands.length;
    newRun(false);
  });
  $("auth-button").addEventListener("click", (event) => {
    authorization = !authorization;
    event.currentTarget.textContent = `AUTH ${authorization ? "ON" : "OFF"}`;
    event.currentTarget.setAttribute("aria-pressed", String(authorization));
  });
  $("emergency-button").addEventListener("click", requestEmergency);
  $("speed-button").addEventListener("click", (event) => {
    const speeds = [1, 2, 4];
    speedIndex = (speedIndex + 1) % speeds.length;
    speed = speeds[speedIndex];
    event.currentTarget.textContent = `${speed}× SPEED`;
  });
  $("new-run-button").addEventListener("click", newRun);
  $("start-button").addEventListener("click", startSimulation);
  $("pause-button").addEventListener("click", (event) => {
    if (completed || !hasStarted) return;
    paused = !paused;
    lastFrame = 0;
    event.currentTarget.textContent = paused ? "RESUME" : "PAUSE";
  });
  $("close-charts").addEventListener("click", () => {
    chartOpen = false;
    $("charts-modal").classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      if (completed || !hasStarted) return;
      event.preventDefault();
      paused = !paused;
      lastFrame = 0;
      $("pause-button").textContent = paused ? "RESUME" : "PAUSE";
    } else if (event.key.toLowerCase() === "r") {
      newRun();
    } else if (event.key === "Escape" && chartOpen) {
      chartOpen = false;
      $("charts-modal").classList.add("hidden");
    }
  });
  $("charts-modal").addEventListener("click", (event) => {
    if (event.target === $("charts-modal")) {
      chartOpen = false;
      $("charts-modal").classList.add("hidden");
    }
  });

  $("charts-button").addEventListener("click", () => {
    chartOpen = true;
    $("charts-modal").classList.remove("hidden");
    drawCharts();
  });
  updateStaticLabels();
  newRun(false, true);
  window.requestAnimationFrame(frame);
})();
