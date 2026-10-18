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

Vehicles travel straight through one of two compatible phases: North/South
(N-S) or East/West (E-W). The fixed controller holds each opposing approach
red for exactly 60 seconds, using 57 seconds of green for its active phase and
3 seconds of yellow clearance. Its red countdown is shown at the red signal.
After yellow, the next phase turns green directly;
this no-all-red behavior is a simulation simplification, not a recommendation
for real-world traffic signals. Adaptive control measures waiting vehicles by
phase:

- `N` is the number of queued vehicles.
- `W` is their total current wait in simulated seconds.
- `M` is the longest individual current wait.
- Pressure is `P = 2N + W/30`.

At a phase choice, an authorized emergency request is considered first.
Otherwise, a phase with a vehicle waiting at least 60 seconds receives fairness
priority (longest wait first, pressure breaks ties); remaining ties use pressure,
maximum wait, then a deterministic N-S tie-break. The adaptive green normally has a 6-second minimum. The empty-road override
starts the 3-second yellow immediately if the current phase has zero queued
vehicles and the opposing phase has at least one waiting vehicle, even before
that minimum; after yellow, the opposing phase turns green. It does not switch
when both phases have no queued demand. All other queue-driven decisions are
held until at least 10 seconds of green; a 3-or-more vehicle advantage must
persist for four
consecutive 0.05-second simulation checks (0.2 seconds) before switching.
This short hysteresis filters threshold flicker without adding a timed delay.
An opposing phase with a 60-second-old waiting vehicle also triggers a fairness
switch. Normal maximum green is 30 seconds. It may extend to 60 seconds only
when the current queue has at least 10 vehicles and is at least twice the
opposing queue; a 3-car advantage or overdue opposing wait still triggers a
switch during that extension. If the opposing phase has no demand, the current
green can extend rather than waste time on an empty road; when demand appears,
the maximum-green and priority rules apply. These conditions are configurable
simulation constants in `script.js`.

Every conflicting phase change uses GREEN → YELLOW → opposing GREEN. Both
controllers use exactly 3 seconds of yellow and no all-red interval. Removing
all-red is an educational simulation simplification, not a recommendation for
real-world signal timing. The adaptive controller idles when both phases have
no waiting vehicles and no vehicles are crossing. Fixed and adaptive
controllers receive identical deterministic arrivals and start at the same
simulated time.

Mean waiting time uses one consistent definition: each vehicle's wait ends
when it starts moving, and the live/chart mean combines those recorded waits
with the current wait of every vehicle still queued. Changing signals never
resets a vehicle's wait. The charts report measured simulation outcomes and do
not force an adaptive win.

## GitHub Pages

Upload `index.html`, `style.css`, `script.js`, `README.md`, and `.nojekyll` to
the repository root. In **Settings → Pages**, choose **Deploy from a branch**,
then select the default branch and `/ (root)`.
