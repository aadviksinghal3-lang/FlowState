# Flowstate — Smart Traffic Flow Optimizer

Flowstate is a browser-based educational traffic simulation that compares a
fixed-timer controller with an adaptive signal controller at the same
four-approach intersection. Both systems receive an identical, deterministic
stream of ordinary vehicle arrivals. The dashboard shows the two intersections,
live signal decisions, queues, wait-time metrics, completed vehicle crossings,
and a side-by-side chart comparison. A shared 20-car E-W opening surge makes
the queue difference visible immediately; all later arrivals are also shared
between both controllers.

This project is a simulation only. It does not use live traffic data or control
real traffic signals. Each run starts with the same 20-vehicle surge split
across the E-W approaches; this is labeled on the dashboard, not hidden, and
lets viewers immediately compare the adaptive response with the fixed plan.

## Project files

- `index.html` — dashboard structure, comparison cards, controls, and charts
- `style.css` — responsive visual design and intersection/car presentation
- `script.js` — reproducible traffic scenarios, vehicle movement, signal logic,
  metrics, emergency requests, and charts
- `tune_planner.js` — random-search tuner for the cycle planner constants
- `compare_scenarios.js` — compares fixed and adaptive control on all 9 scenario/demand cases
- `check_rule.js` — checks the 3-car switching rule and 10 s minimum green
- `sim_loader.js` — runs the real simulator headlessly for the two scripts above
- `.nojekyll` — tells GitHub Pages to serve the project without Jekyll

## Run locally

No package installation or build step is needed. Open `index.html` directly,
or serve the project from this directory:

```powershell
python -m http.server 8000
```

Then visit <http://localhost:8000>.

## Controls

- **Scenario** cycles between Morning rush, Balanced flow, and Event surge.
- **Demand** cycles between Low, Medium, and High generated arrival rates.
- **Auth On/Off** controls authorization for the simulated emergency request.
- **Emergency** inserts a priority vehicle in the same approach in both runs.
  An unauthorized request is visibly denied; authorized requests do not skip
  the yellow clearance period. Adaptive control prioritizes an authorized
  request; the fixed-timer baseline keeps its scheduled signal cycle.
- **Speed** cycles through 1×, 2×, and 4× simulation time.
- The page opens in a ready state. Press **Start** to begin the simulation;
  the opening traffic surge and simulation clock start only after this action.
- **New Run** creates a new deterministic scenario seed. Each run ends at
  3 minutes 30 seconds of simulated time; the dashboard then displays
  “SIMULATION COMPLETE PRESS NEW RUN TO START THE SIMULATION AGAIN.”
- **Pause/Resume** and the **Space** key pause or resume both simulations.
- **R** starts a new run. **Charts** opens vehicle-cleared and average-wait
  bars for the current live runs; the bars and values continue updating while
  the chart is open. The average includes completed waits and vehicles still
  queued. Close the charts with the cross or **Escape**.

## Controller methodology

**Separate signal for every road.** North, East, South and West each have their
own signal head, countdown and red/yellow/green state. Only one road is green at
a time, so left turns, right turns and straight movements from that road never
conflict with other traffic. Every change is GREEN → YELLOW (exactly 3 seconds)
→ next road GREEN, with no all-red interval (a simulation simplification, not a
recommendation for real-world signals).

**Turning vehicles.** About 20% of generated vehicles turn left, 20% turn right
and 60% go straight. The turn is fixed per vehicle from the run seed, so both
controllers receive identical vehicles. Turning cars show a blinking amber
indicator until they start the turn, then follow a curved path into the correct
lane of the destination road. Each road is a single queue (no separate turn
lanes), and one car is released every 1.1 seconds on green. Turn paths are
capped so a car always clears the junction within the 3-second yellow.

**Platoon bursts.** Besides steady random arrivals, a group of 5-9 cars reaches
one road within a few seconds roughly every 14-24 seconds (the road is chosen
by the scenario's traffic weights). Bursts are part of the shared arrival
stream, so both controllers see them. They make queues jump while a road is red
under the fixed timer; constants are `BURST_*` in `script.js`.

**Signal timers.** On the fixed card each red light counts down to its next green
and the green light counts down its remaining time. Adaptive green and red times
are not scheduled in advance, so the adaptive card shows actual elapsed time:
`GREEN 9.0s` is how long that road has been green, `RED 23.4s` is how long it has
been red, and yellow counts down its 3 seconds.

**Adaptive cycle planner (default).** Each cycle the busy roads share **at most 60
seconds of green**:

- Roads with no cars get **no green** (shown as `RED NO CARS`); they are skipped and
  their time goes back to the shared pool.
- Each road's green is planned from its queue plus cars expected in the next 10
  seconds (about 1.1 s per car plus 2 s start-up), with at least 10 s for a road that
  needs it. A road with more cars gets more of the 60 s, and a road with few cars
  gets less, so its red time per cycle is longer while the busy road's green is longer.
- If a green ends with cars still waiting and unused cycle time remains (for
  example because another road was skipped or finished early), the green is
  **extended in 12 s steps** (e.g. 20 s to 32 s) as long as at least one car is still
  waiting. The decision line reports it, for example "W still has 9 cars: green
  extended 20s → 32s... Red time +12s on N, E".
- **Switching rule (preemption):** while a road is green, the controller compares it
  with the other roads. If another road has **1-2 more cars, or the same number, the
  green stays**. If another road has **3 or more more cars**, the green road gets yellow and
  that road gets green **once the 10-second minimum green is over**, even if the first road
  is not clear. If the green road becomes empty it ends after a 2-second gap-out and
  yellow. Its leftover cars wait for their turn in the new cycle plan. The thresholds are
  constants in `script.js` (`PREEMPT_MIN_GAP`, `PREEMPT_MIN_GREEN`). A much higher threshold
  (+30 cars) gives lower mean wait (28.1 s vs 31.9 s) but lets a big queue wait while a
  small road stays green, so the visible rule above is used.
- A road whose queue empties ends its green after 3 s of nothing and returns the
  unused seconds to the other roads. Each cycle starts with the road that has the
  biggest planned green, and every road that has cars gets a turn in that cycle.
- All timers count down. A green light shows its remaining time (with `(+12)` after
  an extension). A red light shows the estimated time until its next green, which
  grows when another road is extended or a skipped road gets cars.
- Authorized emergency vehicles are the one exception to the 60 s budget: the
  emergency road gets a short extra green (even if the request arrives during a yellow),
  then the cycle resumes. Over 32 test requests the adaptive controller cleared the
  emergency vehicle in 2.4 s on average and 6.5 s at worst.

**Fixed timer.** Roads are served in the order N → E → S → W with 17 seconds of
green and 3 seconds of yellow each, so every road is red for exactly 60 seconds
per cycle (shown as a countdown at its own signal).

**Queue statistics.** The small tiles above each intersection show, per road, the
queued cars (`N`), a pressure value `P = 2N + W/30 + 2A` (where `W` is total current wait
and `A` is the expected arrivals in the next 6 seconds, estimated from the last 10 seconds
of arrivals; the shared opening surge is excluded), the arrival rate (`IN`, per minute) and the
longest current wait (`M`). The planner sizes greens from `N` and the arrival rate.

**Adaptive end of cycle.** The adaptive controller idles when no road has waiting vehicles
and none are crossing; it starts a new cycle as soon as cars appear. It never gives green
to a road without cars, so the 3-second yellow is also skipped when only one road has cars
and its green simply continues. An authorized emergency request gets a short priority
green after the 6-second minimum green, then the cycle resumes; an unauthorized request is
visibly denied.

Mean waiting time uses one consistent definition: each vehicle's wait ends when
it starts moving, and the live/chart mean combines those recorded waits with the
current wait of every vehicle still queued. The charts report measured
simulation outcomes and do not force an adaptive win. Constants are at the top
of `script.js`.

## Scenario comparison and tuning

**All controllers, same traffic.** Fresh seeds 401-408 on all 9 scenario/demand cases
(72 runs each). Mean wait includes cars still queued at the end.

| Controller | Mean wait | Cars cleared | Queued at end | Longest wait |
|---|---|---|---|---|
| Fixed timer | 48.5s | 138.6 | 71.2 | 125.2s |
| Rule-based adaptive (queue-advantage switching) | 31.3s | 158.3 | 52.2 | 81.3s |
| Cycle planner v1 (earlier defaults) | 29.8s | 161.9 | 48.5 | 81.0s |
| Q-learning RL policy (tested, removed) | 28.8s | 162.0 | 48.5 | 77.6s |
| "Hold green until the road empties" rule | 28.8s | 162.0 | 48.5 | 77.6s |
| **Cycle planner v2 (tuned, shipped)** | **28.6s** | **163.6** | **46.9** | 82.0s |

The shipped planner has the lowest mean wait and the most cars cleared. The RL policy
learned exactly the "hold green until the road empties" behavior (identical results), so
it was dropped. The planner is the only one that also keeps the 60 s green budget, skips
empty roads, extends greens, preempts and shows countdown timers. It is not the best at
worst-case wait (RL/hold-green is about 4 s lower).

`node tune_planner.js` randomly searches the planner constants (minimum green, extension
size and trigger, road ordering, arrival look-ahead, start-up allowance, car headway,
gap-out time and preemption thresholds) on validation seeds, then re-tests the best
candidates on separate seeds. The 60 s green budget, empty-road skipping and preemption
are fixed requirements and are not tuned away. The tuned defaults beat the previous ones
on the test seeds (28.5 s to 27.7 s mean wait, 162.4 to 163.5 cars cleared).

`node compare_scenarios.js` runs every scenario x demand on seeds 21-28 (8 runs per cell):

| Scenario / demand | Fixed wait | Adaptive wait | Fixed cleared | Adaptive cleared | Wait saved | Extra cars |
|---|---|---|---|---|---|---|
| Morning rush / Low | 38.2s | 14.7s | 122.4 | 145.1 | 61% | +22.8 |
| Morning rush / Medium | 43.6s | 26.5s | 136.4 | 156.3 | 39% | +19.9 |
| Morning rush / High | 50.3s | 42.2s | 146.9 | 158.4 | 16% | +11.5 |
| Balanced flow / Low | 41.2s | 15.0s | 121.1 | 144.5 | 64% | +23.4 |
| Balanced flow / Medium | 46.1s | 26.6s | 134.5 | 156.8 | 42% | +22.3 |
| Balanced flow / High | 51.9s | 43.9s | 150.6 | 156.5 | 15% | +5.9 |
| Event surge / Low | 45.8s | 20.9s | 127.1 | 156.3 | 54% | +29.1 |
| Event surge / Medium | 56.2s | 42.2s | 141.9 | 157.5 | 25% | +15.6 |
| Event surge / High | 63.6s | 56.9s | 151.5 | 157.5 | 11% | +6.0 |
| **All 9 (average)** | 48.5s | 32.1s | 136.9 | 154.3 | 34% | +17.4 |

Adaptive control wins in all nine scenarios: on average 34% less mean wait and about 17
more cars cleared (+13%), with 50 cars still queued at the end versus 66 for the fixed
timer. The margin is largest at low and medium demand and smallest in the saturated "High"
cases, where the road is over capacity for any signal plan. In 36 checked runs planned green
never exceeded 60 s per cycle and no green started on an empty road. `check_rule.js`
confirms (318 rule-based switches in 36 runs) that no queue-based switch happened before 10 s
of green, that the green never stayed on for more than about half a second after another road
had 3+ more cars, and that a 0-2 car difference kept the green.

**Switching-threshold tradeoff** (seeds 401-406): switch at +3 cars (shipped) 31.9 s mean
wait / 156.2 cars cleared / 101 s longest wait; switch at +30 cars 28.1 s / 163.4 cars / 81 s;
fixed timer 48.3 s / 137.8 cars. Re-tuning the other constants around the +3 rule changed
mean wait by less than 0.3 s, so the threshold is what decides the result.
