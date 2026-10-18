"use strict";

(() => {
  const DIRECTIONS = ["N", "E", "S", "W"];
  const PHASES = ["NS", "EW"];
  const PHASE_DIRS = { NS: ["N", "S"], EW: ["E", "W"] };
  const SIM_DURATION = 210;
  const YELLOW_SECONDS = 3;
  const FIXED_RED_SECONDS = 60;
  const FIXED_GREEN = FIXED_RED_SECONDS - YELLOW_SECONDS;
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
  const scenarios = [
    { name: "Morning rush", description: "North-south commuter flow", weights: [0.33, 0.16, 0.31, 0.20] },
    { name: "Balanced flow", description: "Balanced four-approach traffic flow", weights: [0.25, 0.25, 0.25, 0.25] },
    { name: "Event surge", description: "Event release with a short demand surge", weights: [0.22, 0.28, 0.22, 0.28] },
  ];
  const demands = [
    { name: "Low", rate: 0.18 },
    { name: "Medium", rate: 0.27 },
    { name: "High", rate: 0.39 },
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
    const arrivals = Array.from({ length: OPENING_EW_SURGE_VEHICLES }, (_, index) => ({
      time: 0,
      direction: index % 2 === 0 ? "E" : "W",
      id: `opening-ew-surge-${index}`,
    }));
    const scenario = scenarios[scenarioIndex];
    const rate = demands[demandIndex].rate;
    for (let index = 0; index < DIRECTIONS.length; index += 1) {
      let time = -Math.log(Math.max(0.000001, random())) / (rate * scenario.weights[index] * 2.9);
      while (time < SIM_DURATION) {
        const surge = scenarioIndex === 2 && time > 50 && time < 125 ? 2.1 : 1;
        arrivals.push({ time, direction: DIRECTIONS[index], id: `${index}-${arrivals.length}` });
        time += -Math.log(Math.max(0.000001, random())) / (rate * scenario.weights[index] * 2.9 * surge);
      }
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
      phase: kind === "fixed" ? "NS" : null,
      stage: kind === "fixed" ? "green" : "no-demand",
      remaining: kind === "fixed" ? FIXED_GREEN : 0,
      signalChangeAt: kind === "fixed" ? 0 : null,
      phaseChanges: [],
      stageChanges: kind === "fixed" ? [0] : [],
      greenElapsed: 0,
      greenTarget: kind === "fixed" ? FIXED_GREEN : null,
      queueAdvantageChecks: 0,
      pendingPhase: null,
      decision: kind === "fixed" ? "Fixed schedule: 60 seconds of opposing red, including yellow clearance." : "Waiting for vehicles.",
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
    const result = { NS: { count: 0, wait: 0, max: 0, pressure: 0 }, EW: { count: 0, wait: 0, max: 0, pressure: 0 } };
    for (const direction of DIRECTIONS) {
      const phase = direction === "N" || direction === "S" ? "NS" : "EW";
      for (const vehicle of run.queues[direction]) {
        const wait = Math.max(0, run.time - vehicle.arrival);
        result[phase].count += 1;
        result[phase].wait += wait;
        result[phase].max = Math.max(result[phase].max, wait);
      }
    }
    for (const phase of PHASES) {
      const stat = result[phase];
      stat.pressure = stat.count ? 2 * stat.count + stat.wait / 30 : 0;
    }
    return result;
  }

  function choosePhase(run, stats) {
    if (run.emergency && run.emergency.authorized) {
      return { phase: phaseFor(run.emergency.direction), reason: `Emergency request from ${run.emergency.direction}; priority selection.` };
    }
    const demanded = PHASES.filter((phase) => stats[phase].count > 0);
    if (!demanded.length) return { phase: null, reason: "No demand on any approach." };
    if (demanded.length === 1) return { phase: demanded[0], reason: `${demanded[0]} selected because the other phase has no demand.` };
    const overdue = demanded.filter((phase) => stats[phase].max >= 60);
    if (overdue.length) {
      overdue.sort((a, b) => stats[b].max - stats[a].max || stats[b].pressure - stats[a].pressure || PHASES.indexOf(a) - PHASES.indexOf(b));
      const phase = overdue[0];
      return { phase, reason: `Fairness priority: ${phase} has the longest overdue wait (${stats[phase].max.toFixed(1)}s).` };
    }
    const ns = stats.NS;
    const ew = stats.EW;
    if (ns.count >= 2 * ew.count) return { phase: "NS", reason: `Larger queue priority: N-S has ${ns.count} vehicles versus E-W ${ew.count}.` };
    if (ew.count >= 2 * ns.count) return { phase: "EW", reason: `Larger queue priority: E-W has ${ew.count} vehicles versus N-S ${ns.count}.` };
    if (ns.pressure !== ew.pressure) {
      const phase = ns.pressure > ew.pressure ? "NS" : "EW";
      return { phase, reason: `${phase} selected for higher pressure (${stats[phase].pressure.toFixed(1)}).` };
    }
    if (ns.max !== ew.max) {
      const phase = ns.max > ew.max ? "NS" : "EW";
      return { phase, reason: `${phase} selected for longer maximum wait.` };
    }
    return { phase: "NS", reason: "Pressure and wait are tied; deterministic N-S tie-break." };
  }

  function phaseFor(direction) {
    return direction === "N" || direction === "S" ? "NS" : "EW";
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
    }
  }

  function serve(run, dt) {
    if (run.stage !== "green" || !run.phase) return;
    for (const direction of PHASE_DIRS[run.phase]) {
      const queue = run.queues[direction];
      if (queue.length && !run.moving.some((vehicle) => vehicle.direction === direction)) {
        const vehicle = queue.shift();
        vehicle.wait = Math.max(0, run.time - vehicle.arrival);
        run.completedWaits.push(vehicle.wait);
        run.moving.push({
          ...vehicle,
          moving: 0,
          crossingDuration: crossingDuration(run, direction),
        });
      }
    }
  }

  function crossingDuration(run, direction) {
    const intersection = $(`${run.kind}-intersection`);
    if (typeof intersection.getBoundingClientRect !== "function") return CROSS_SECONDS;
    const { width, height } = intersection.getBoundingClientRect();
    if (!width || !height) return CROSS_SECONDS;
    const vertical = direction === "N" || direction === "S";
    const distance = vertical
      ? height * (direction === "N" ? 0.73 : 0.71)
      : width * 0.63;
    return CROSS_SECONDS * distance / (width * 0.48);
  }

  function tickFixed(run, dt, stats) {
    if (run.stage === "green") run.greenElapsed += dt;
    run.remaining = Math.max(0, run.remaining - dt);
    if (run.stage === "green" && run.remaining <= 0.000001) {
      run.stage = "yellow";
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.remaining = YELLOW_SECONDS;
      run.decision = `Fixed plan: ${run.phase} yellow clearance.`;
    } else if (run.stage === "yellow" && run.remaining <= 0.000001) {
      run.phase = run.phase === "NS" ? "EW" : "NS";
      run.signalChangeAt = run.time;
      run.phaseChanges.push(run.time);
      run.stageChanges.push(run.time);
      run.stage = "green";
      run.remaining = FIXED_GREEN;
      run.greenTarget = FIXED_GREEN;
      run.greenElapsed = 0;
      run.decision = `Fixed schedule: ${run.phase} active; opposing approaches remain red for 60 seconds.`;
    }
  }

  function tickAdaptive(run, dt, stats) {
    if (run.stage === "no-demand") {
      const selection = choosePhase(run, stats);
      if (selection.phase) {
        startGreen(run, selection.phase, selection.reason, stats);
      }
      else run.decision = selection.reason;
      return;
    }
    if (run.stage === "yellow") {
      run.remaining = Math.max(0, run.remaining - dt);
      if (run.remaining <= 0.000001) {
        const selection = choosePhase(run, stats);
        let target = run.pendingPhase;
        if (run.emergency && selection.phase) target = selection.phase;
        if (!target || !stats[target].count) target = selection.phase;
        if (target) {
          startGreen(run, target, run.decision, stats);
        } else {
          run.phase = null;
          run.stage = "no-demand";
          run.signalChangeAt = run.time;
          run.stageChanges.push(run.time);
          run.greenTarget = null;
          run.decision = "No demand on any approach.";
        }
      }
      return;
    }
    const anyQueuedDemand = PHASES.some((phase) => stats[phase].count > 0);
    if (!anyQueuedDemand && run.moving.length === 0) {
      run.phase = null;
      run.stage = "no-demand";
      run.remaining = 0;
      run.greenTarget = null;
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.decision = "No demand on any approach; signal is idle.";
      return;
    }
    run.greenElapsed += dt;
    run.remaining = Math.max(0, run.greenTarget - run.greenElapsed);
    const current = run.phase;
    const other = current === "NS" ? "EW" : "NS";
    const currentStat = stats[current];
    const otherStat = stats[other];
    const emptyCurrentSwitch = currentStat.count === 0 && otherStat.count > 0;
    const normalSwitchEligible = run.greenElapsed >= ADAPTIVE_NORMAL_SWITCH_GREEN;
    const queueAdvantage = otherStat.count - currentStat.count >= QUEUE_SWITCH_DIFFERENCE;
    run.queueAdvantageChecks = normalSwitchEligible && queueAdvantage
      ? run.queueAdvantageChecks + 1
      : 0;
    const largeQueueSwitch = normalSwitchEligible
      && run.queueAdvantageChecks >= QUEUE_SWITCH_CONFIRMATIONS;
    const emergencySwitch = run.emergency && run.emergency.authorized && phaseFor(run.emergency.direction) === other;
    const fairnessSwitch = normalSwitchEligible && otherStat.max >= 60;
    const heavyTraffic = currentStat.count >= HEAVY_QUEUE_THRESHOLD
      && currentStat.count >= HEAVY_QUEUE_RATIO * otherStat.count;
    const maximumGreen = heavyTraffic ? ADAPTIVE_HEAVY_MAX_GREEN : ADAPTIVE_MAX_GREEN;
    const maximumReached = run.greenElapsed >= maximumGreen;
    const maximumSwitch = maximumReached && otherStat.count > 0;
    if (!(emptyCurrentSwitch || largeQueueSwitch || emergencySwitch || fairnessSwitch || maximumSwitch)) {
      if (run.greenElapsed >= ADAPTIVE_MAX_GREEN && otherStat.count === 0 && currentStat.count > 0) {
        run.decision = `${other} has no demand; extending ${current} green to keep serving its waiting queue.`;
        run.greenTarget = null;
        run.remaining = 0;
      } else if (run.greenElapsed >= ADAPTIVE_MAX_GREEN && heavyTraffic && otherStat.count > 0) {
        run.decision = `Heavy traffic on ${current}: extending green up to ${ADAPTIVE_HEAVY_MAX_GREEN}s while monitoring ${other} demand.`;
        run.greenTarget = ADAPTIVE_HEAVY_MAX_GREEN;
        run.remaining = Math.max(0, run.greenTarget - run.greenElapsed);
      }
      return;
    }

    let selection = choosePhase(run, stats);
    if (emergencySwitch) selection = { phase: other, reason: `Authorized emergency from ${run.emergency.direction}; safe yellow clearance started.` };
    else if (emptyCurrentSwitch) selection = { phase: other, reason: `Current phase is empty; switching to waiting ${other} traffic.` };
    else if (fairnessSwitch) selection = { phase: other, reason: `Fairness priority: ${other} has waited ${otherStat.max.toFixed(1)}s; switching to prevent starvation.` };
    else if (largeQueueSwitch) selection = { phase: other, reason: `Queue advantage held for ${QUEUE_SWITCH_CONFIRMATIONS} consecutive checks: ${other} has ${otherStat.count - currentStat.count} more vehicles.` };
    else if (maximumSwitch) selection = { phase: other, reason: heavyTraffic
      ? `Heavy-traffic 60s limit reached; switching to waiting ${other} traffic.`
      : `Normal 30s maximum reached; switching to waiting ${other} traffic.` };

    if (selection.phase && selection.phase !== current) {
      run.stage = "yellow";
      run.signalChangeAt = run.time;
      run.stageChanges.push(run.time);
      run.remaining = YELLOW_SECONDS;
      run.pendingPhase = selection.phase;
      run.decision = selection.reason;
    }
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
      else tickAdaptive(run, step, stats);
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
        countdown.className = "signal-countdown red";
        countdown.textContent = `RED ${(
          run.stage === "green" ? run.remaining + YELLOW_SECONDS : run.remaining
        ).toFixed(1)}s`;
      } else if (signalPhase === run.phase && run.stage !== "no-demand") {
        countdown.className = `signal-countdown ${run.stage}`;
        countdown.textContent = run.stage === "yellow"
          ? `${run.remaining.toFixed(1)}s`
          : run.greenTarget === null
            ? "EXT"
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
      const vertical = direction === "N" || direction === "S";
      const heading = { N: "south", S: "north", W: "east", E: "west" }[direction];
      car.className = `car heading-${heading} ${vertical ? "vertical" : ""} ${vehicle.emergency ? "emergency" : ""}`;
      const window = document.createElement("span");
      window.className = "car-window";
      const headlights = document.createElement("span");
      headlights.className = "car-lights headlights";
      const taillights = document.createElement("span");
      taillights.className = "car-lights taillights";
      car.append(window, headlights, taillights);
      placeCar(car, direction, index, vehicle, isMoving);
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

  function placeCar(car, direction, index, vehicle, moving) {
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
    return run.phase ? `${run.phase === "NS" ? "N-S" : "E-W"}` : "NO DEMAND";
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
    $(`${prefix}-stats`).innerHTML = `
      <div class="approach-stat"><span>N-S P ${stats.NS.pressure.toFixed(1)} &nbsp; W ${stats.NS.wait.toFixed(0)}s &nbsp; M ${maxWait(run, "NS").toFixed(0)}s</span><strong>${stats.NS.count} cars</strong></div>
      <div class="approach-stat"><span>E-W P ${stats.EW.pressure.toFixed(1)} &nbsp; W ${stats.EW.wait.toFixed(0)}s &nbsp; M ${maxWait(run, "EW").toFixed(0)}s</span><strong>${stats.EW.count} cars</strong></div>`;
    const badge = $(`${prefix}-badge`);
    badge.className = `signal-badge ${statusColor(run)}`;
    badge.querySelector("span:last-child").textContent = run.stage === "no-demand" ? "NO DEMAND" : `${phaseLabel(run)} ${run.stage.toUpperCase()}`;
    const status = $(`${prefix}-status`);
    status.className = `system-status ${statusColor(run)}`;
    status.textContent = run.stage === "green"
      ? run.greenTarget === null
        ? `${phaseLabel(run)} GREEN  |  ${run.greenElapsed.toFixed(1)}s ELAPSED  |  EXTENDED: OPPOSING PHASE HAS NO DEMAND`
        : `${phaseLabel(run)} GREEN  |  ${run.greenElapsed.toFixed(1)}s ELAPSED  |  TARGET ${run.greenTarget}s`
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
    $(`${prefix}-summary`).textContent = `PEAK ${run.maxQueue} cars &nbsp; | &nbsp; N-S M ${maxWait(run, "NS").toFixed(0)}s &nbsp; E-W M ${maxWait(run, "EW").toFixed(0)}s`;
    card.dataset.stage = run.stage;
  }

  function draw() {
    if (!runs) return;
    renderRun(runs.fixed);
    renderRun(runs.adaptive);
    $("run-status").textContent = completed ? "COMPLETE" : !hasStarted ? "READY" : paused ? "PAUSED" : "LIVE";
    $("completion-banner").hidden = !completed;
    $("run-meta").textContent = `SHARED ARRIVALS / 210s &nbsp; | &nbsp; SEED ${seed}`;
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
    $("scenario-description").textContent = `20-car E-W opening surge · ${scenarios[scenarioIndex].description}`;
    $("run-meta").textContent = `SHARED ARRIVALS / 210s &nbsp; | &nbsp; SEED ${seed}`;
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
