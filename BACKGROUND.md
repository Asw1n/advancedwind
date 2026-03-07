# Advanced Wind – Plugin Background Reference

This document is intended for AI agents and developers who need to understand the
codebase quickly. It covers the purpose of the plugin, the data model, every
calculation step, the configuration system, the existing webapp, and the planned
Insight webapp.

---

## 1. Purpose

**Advanced Wind** is a [Signal K](https://signalk.org/) server plugin that
calculates true wind (water wind) from apparent wind and boat speed. Beyond a
basic true-wind calculation it can apply a chain of corrections, each of which is
individually optional and parameterisable:

1. Sensor misalignment  
2. Mast rotation (rotating mast vessels)  
3. Mast heel (tilt of mast when boat heels)  
4. Mast movement (wave-induced sensor motion)  
5. Upwash (sail-induced airflow distortion)  
6. Leeway (sideways drift of the hull)  
7. Height / wind-gradient normalisation to 10 m  

Optionally it also calculates **ground wind** (wind over ground using COG/SOG).

The plugin exposes a REST API (under the Signal K plugin API path
`/plugins/advancedwind`) and hosts a built-in webapp.

---

## 2. Repository structure

```
index.js          – Signal K plugin entry point (all server-side logic)
package.json      – npm metadata and Signal K plugin declaration
CHANGELOG.md      – version history
public/
  index.html      – webapp (pipeline inspector, step-by-step view, live config)
  insight.js      – JavaScript for index.html
  main.css        – stylesheet
```

---

## 3. Signal K integration

| Aspect | Detail |
|---|---|
| Plugin ID | `advancedwind` (package name) in `index.js`, `plugin.id = "AdvancedWind"` |
| Plugin API base URL | `/plugins/advancedwind` |
| Dependency | [`signalkutilities`](https://github.com/Asw1n/signalkutilities) – provides `Polar`, `Reporter`, `KalmanSmoother`, `createSmoothedHandler`, `createSmoothedPolar` |
| Reads SK paths | `navigation.headingTrue`, `navigation.attitude`, `navigation.speedThroughWater`, `navigation.leewayAngle`, `environment.wind.speedApparent`, `environment.wind.angleApparent`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`, `environment.wind.speedOverGround` (ground wind in), `environment.wind.directionTrue` (ground wind in), + configurable mast rotation path |
| Writes SK paths | `environment.wind.speedTrue`, `environment.wind.angleTrueWater`, optionally `environment.wind.speedApparent`, `environment.wind.angleApparent` (back-calculated), optionally `environment.wind.speedOverGround`, `environment.wind.directionTrue` (ground wind out) |

---

## 4. Data model – `signalkutilities`

The plugin uses these classes from `signalkutilities`:

### `Polar`
Represents a 2-D vector (speed + angle) in either the boat plane or the ground
plane. Key properties exposed in reports:

| Property | Meaning |
|---|---|
| `id` | unique string identifier |
| `magnitude` | vector length (m/s internally) |
| `angle` | vector angle in radians |
| `x`, `y` | Cartesian components |
| `displayAttributes.label` | human-readable name |
| `displayAttributes.plane` | `"Boat"` or `"Ground"` |
| `stale` | `true` when source data is missing/outdated |

Important `Polar` methods used in `index.js`: `copyFrom`, `substract`, `add`,
`rotate`, `scale`, `setVectorValue`, `send` (static, writes to Signal K).

### `createSmoothedPolar`
Factory that creates a `Polar` with Kalman-smoothed subscriptions for two Signal
K paths (magnitude + angle). The `passOn` option controls whether the original
subscription delta is forwarded to Signal K (used for `preventDuplication`).

### `createSmoothedHandler`
Factory that creates a single-value handler (e.g. heading, mast rotation) with
Kalman smoothing.

### `Reporter`
Aggregates all `Polar` and handler instances into a snapshot report. The report
is served from the `/state` API endpoint as JSON:

```json
{
  "polars":    [{ "id": "apparentWind", "magnitude": 5.1, "angle": 0.4, ... }],
  "deltas":    [{ "id": "heading",      "value": 1.23, ... }],
  "attitudes": [{ "id": "attitude",     "value": { "roll": 0.05, "pitch": 0.01, "yaw": 0 }, ... }],
  "tables":    []
}
```

---

## 5. Plugin lifecycle (`index.js`)

### `plugin.start()`
1. Calls `readOptions()` – loads flat options from Signal K config store,
   migrating grouped/old formats as needed.
2. Creates all `Polar` and handler instances.
3. Registers them with `reportFull` (a `Reporter`).
4. Attaches `apparentWind.onChange` callback that triggers `calculate()` every
   time a new apparent wind delta arrives.
5. Sets `isRunning = true`.

### `plugin.stop()`
Resets all state and calls `.terminate()` on every handler.

### `calculate()` – the calculation pipeline (called on every apparent wind update)

```
apparentWind (observed)
  │
  ├─ [correctForMisalign]     rotate by −sensorMisalignment
  ├─ [correctForMastRotation] rotate by −mastRotation
  ├─ [correctForMastHeel]     scale x/y by 1/cos(pitch) and 1/cos(roll)
  ├─ [correctForMastMovement] subtract sensorSpeed (= attitude-rate × height)
  ├─ [correctForUpwash]       rotate by −upwash (formula below)
  ├─ [correctForLeeway]       rotate by −leewayAngle
  │
  └─> calculatedWind  (= corrected apparent wind / vessel wind)
        │
        └─ subtract boatSpeed  →  trueWind
              │
              ├─ [correctForHeight]  scale trueWind by windGradient;
              │                      recalculate calculatedWind = trueWind + boatSpeed
              │
              └─ [calculateGroundWind]  rotate by heading, subtract groundSpeed
                                         → groundWind
```

**Upwash formula:**
```
upwash = (upwashSlope × AWA_radians + upwashOffset × π/180) × max(0, cos(AWA))
```
Where `AWA` is the apparent wind angle in radians.

**Wind gradient formula:**
```
factor = (10 / heightAboveWater) ^ windExponent
trueWindSpeed = trueWindSpeed × factor
```

---

## 6. Configuration (options)

### Storage format
Options are stored **flat** inside Signal K's configuration store, regardless of
the grouped schema used for the UI. The current version tag is `"3.0"`.

Example flat options object (`options` variable at runtime):

```js
{
  version: "3.0",
  // Corrections
  correctForMisalign:    false,
  correctForMastRotation: false,
  correctForMastHeel:    false,
  correctForMastMovement: false,
  correctForUpwash:      false,
  correctForLeeway:      false,
  correctForHeight:      false,
  // Output
  calculateGroundWind:   false,
  backCalculateApparentWind: true,
  preventDuplication:    true,
  // Parameters
  sensorMisalignment:    0,
  heightAboveWater:      15,
  windExponent:          0.14,
  upwashSlope:           0.05,
  upwashOffset:          1.5,
  timeConstant:          1,
  // Sources
  headingSource:         "",
  attitudeSource:        "",
  boatSpeedSource:       "",
  windSpeedSource:       "",
  rotationPath:          "",
  rotationSource:        "",
  groundSpeedSource:     ""
}
```

### Schema (for Signal K built-in UI)
`plugin.schema` defines four logical groups used as tabs in the Signal K UI:

| Group key | Tab label | Contains |
|---|---|---|
| `corrections` | Corrections | 7 boolean flags |
| `outputOptions` | Output Options | 3 boolean flags |
| `parameters` | Parameters | 6 numeric values |
| `dataSources` | Data Sources | 7 string source/path values |

`plugin.uiSchema` assigns each group to a named tab via `ui:options.tab`.

### Migration (`readOptions`)
`readOptions()` handles three legacy formats:
1. **Double-nested** (`stored.configuration.configuration`) – flattens and saves.
2. **Empty** – applies `defaultOptions` and saves.
3. **Pre-version (grouped, no version field)** – spreads all sub-groups into flat
   format, sets `version: "3.0"`, saves.
4. **Version 3.0** – uses as-is (flat).

### Runtime config changes
The `/settings` PUT endpoint accumulates changes in `changedOptions`. On the next
`calculate()` call, `applyOptionChanges()` applies source/path changes to live
handlers. **Note:** Only specific keys are handled by `applyOptionChanges()`
(source string changes, `preventDuplication`). Feature flags
(`correctForMisalign` etc.) take effect immediately on the next call because
`calculate()` reads directly from `options`.

The `/settings` PUT endpoint returns the full merged options object, so callers
can update their local cache from the response without a second request.

**Important – schema direction:** `plugin.schema` and `plugin.uiSchema` are set
to empty objects. The webapp (`index.html`) is the sole configuration interface.

---

## 7. REST API endpoints

All endpoints are prefixed with `/plugins/advancedwind`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/state` | Full Reporter snapshot (polars, deltas, attitudes, tables). Primary data source for the webapp. |
| `GET` | `/settings` | Returns current flat `options` object. |
| `PUT` | `/settings` | Accepts partial flat options; merges into `changedOptions`. Returns the full merged options object. |
| `GET` | `/sources?path=<sk-path>` | Placeholder – returns `{ path, sources: [] }`. Not yet implemented. |

---

## 8. Polar (vector) identifiers in the state snapshot

### Primary polars

| `id` | Description | Plane |
|---|---|---|
| `apparentWind` | Smoothed, raw apparent wind from sensor | Boat |
| `calculatedWind` | Corrected apparent wind (running value, updated by each active step) | Boat |
| `trueWind` | True wind (water wind) | Boat |
| `boatSpeed` | Boat speed through water + optional leeway angle | Boat |
| `groundSpeed` | Speed over ground with COG | Ground |
| `groundWind` | Wind over ground | Ground |
| `sensorSpeed` | Computed mast-tip velocity (mast movement correction, internal) | Boat |

### Snapshot polars – per-step before/after

One pair per correction step. The `*In` polar always holds a copy of `calculatedWind`
(or `trueWind` for the height step) taken immediately **before** the step runs.
The `*Out` polar holds a copy taken immediately **after**. Both are written every
calculation cycle regardless of whether the correction is enabled; when disabled,
in and out are identical.

Steps that do not update `calculatedWind` have only an `*In` polar.

| `id` | Description |
|---|---|
| `misalignIn` / `misalignOut` | Wind before / after sensor misalignment correction |
| `mastRotIn` / `mastRotOut` | Wind before / after mast rotation correction |
| `mastHeelIn` / `mastHeelOut` | Wind before / after mast heel correction |
| `mastMoveIn` / `mastMoveOut` | Wind before / after mast movement correction |
| `upwashIn` / `upwashOut` | Wind before / after upwash correction |
| `leewayIn` / `leewayOut` | Wind before / after leeway correction |
| `trueWindIn` | Wind entering the true wind calculation (no output — `calculatedWind` unchanged) |
| `heightIn` / `heightOut` | True wind before height scaling / `calculatedWind` after recalculation |
| `groundWindIn` | Wind entering the ground wind step (no output — `calculatedWind` unchanged) |

Delta identifiers: `heading`, `mast` (mast rotation).
Attitude identifier: `attitude`.

**Note on intermediate correction polars:** The previous approach of storing
per-step snapshots conditionally (only when the correction was active) was
removed. The current scheme always captures both sides of every step so the UI
has consistent data regardless of which corrections are enabled.

---

## 9. Webapp: `index.html` / `insight.js`

The pipeline inspector served by Signal K at `/plugins/advancedwind/`. It
provides a step-by-step view of the entire correction pipeline:

- **Step sidebar** – one nav item per correction step; clicking a step makes it
  active and updates the SVG canvas and right panel.
- **SVG canvas** – live vector diagram showing the relevant polars for the
  current step, auto-scaled and smoothed.
- **Right panel** – step description, enable/disable checkbox (for optional
  corrections), parameter controls (number inputs, checkboxes, source selectors),
  real-time input and output values, stale-source warnings.
- **Config roundtrip** – `PUT /settings` is called on every control change;
  the full merged options object is returned and replaces the local config cache.

---

## 10. New webapp: `index.html` / `insight.js`

### Goal
A step-by-step interactive view of the entire calculation pipeline. For each
correction step the user can:

- See a graphical representation using live data (canvas drawing)
- Enable / disable the correction
- Adjust parameters
- Understand the effect visually

### Current state
- **Layout (`index.html`)**: Header, left nav sidebar, central canvas, right
  panel. Loads `insight.js` as an ES module.
- **Navigation**: Sidebar with one button per step. Steps are defined in the
  `steps` array.
- **Data loop**: Polls `/state` at 100 ms; also fetches `/settings` once at
  startup. State is normalised into `state.polarsById`, `deltasById` etc.
- **Panel rendering** (`renderPanel`): Implements a fixed seven-section layout per step:
  1. Scene title (rendered in the `<h2>` above the panel)
  2. Description (plain text)
  3. Enabled checkbox — only when `correctionFlag` is set
  4. Settings — 2-column table (label | interactive control). Type is driven by
     `paramMeta`: boolean → checkbox, number → number input with `step`/`min`/`max`
     constraints, string → text input
  5. Real-time inputs — 2-column table (name | live value formatted as kn / °).
     Rows go orange when the source is stale
  6. Real-time outputs — same format as inputs
  7. "Cannot be activated because:" — bulleted list, shown only when
     `correctionFlag` is set and at least one input source is stale or absent
- **`paramMeta`**: module-level object mapping every flat config key to
  `{ label, unit, type, step?, min?, max? }`, consumed by the settings table.
- **Canvas** (`renderSVG`): Renders a vector diagram for each step via
  `_buildScenePolars`. Uses the step `id` to select which polars to draw.
- **Config updates** (`updateConfigAtPath`): Sends flat `{ [key]: value }` to
  `/settings`. Returns the full merged options object which replaces the local cache.

### Steps defined in `insight.js`

All `correctionFlag` and `parameters` values are **flat option keys** matching
the runtime `options` object in `index.js`. Each correction scene uses
`calculatedWind` (the running corrected apparent wind) as its primary input.
Source parameters are placed in the scene that uses the corresponding data.

Parameters can be a plain key string (always shown) or an object
`{ key, showIf(config) => boolean }` for conditional visibility. Example:
`preventDuplication` is only shown when `backCalculateApparentWind` is true.

| `id` | Label | `correctionFlag` | Parameters | Inputs | Outputs |
|---|---|---|---|---|---|
| `overview` | Overview | — | — | `apparentWind`, `boatSpeed`, `heading` | `trueWind`, `calculatedWind`, `groundWind` |
| `inputs` | Inputs | — | `windSpeedSource` | `apparentWind` | *(start of pipeline)* |
| `misalign` | Misalignment | `correctForMisalign` | `sensorMisalignment` | `misalignIn` | `misalignOut` |
| `mastRot` | Mast Rotation | `correctForMastRotation` | `rotationPath`, `rotationSource` | `mastRotIn`, `mast` | `mastRotOut` |
| `mastHeel` | Mast Heel | `correctForMastHeel` | `attitudeSource` | `mastHeelIn`, `attitude` | `mastHeelOut` |
| `mastMove` | Mast Movement | `correctForMastMovement` | `heightAboveWater`, `attitudeSource` | `mastMoveIn`, `attitude` | `mastMoveOut`, `sensorSpeed` |
| `upwash` | Upwash | `correctForUpwash` | `upwashSlope`, `upwashOffset` | `upwashIn` | `upwashOut` |
| `leeway` | Leeway | `correctForLeeway` | `boatSpeedSource` | `leewayIn`, `boatSpeed` | `leewayOut` |
| `trueWind` | True Wind | — *(always active)* | `boatSpeedSource` | `trueWindIn`, `boatSpeed` | `trueWind` |
| `height` | Height / 10m | `correctForHeight` | `heightAboveWater`, `windExponent` | `heightIn` | `heightOut` |
| `groundWind` | Ground Wind | `calculateGroundWind` | `groundSpeedSource`, `headingSource` | `groundWindIn`, `groundSpeed`, `heading` | `groundWind` |
| `outputs` | Outputs | — | `backCalculateApparentWind`, `preventDuplication`¹, `calculateGroundWind` | `trueWind`, `calculatedWind`, `groundWind` | *(end of pipeline)* |

¹ `preventDuplication` is only shown when `backCalculateApparentWind` is `true`.

**Stale detection** (`isStale()` helper): checks `data.stale` (top-level flag set
by `signalkutilities`) and `data.displayAttributes.stale` (display-layer flag).
Attitude values are an object `{ roll, pitch, yaw }` exposed via
`state.attitudesById`; stale detection uses the same helper without special-casing.

### Planned visual scenes (not yet implemented)

| Step | Envisioned visualisation |
|---|---|
| Misalignment | Top-down view of boat/mast/sensor; shows wind arrow before and after rotation |
| Mast Heel | Rear view of heeled boat; shows vector decomposition when mast is tilted |
| Mast Movement | Animated mast-tip path; shows subtracted velocity vector |
| Upwash | Wind-flow diagram showing sail bending the apparent wind |
| Leeway | Top-down view; dashed leeway vector from bow |
| True Wind | Vector triangle: corrected apparent wind − boat speed = true wind |
| Height | Graph of wind-speed-vs-height curve with sensor and 10 m markers |
| Ground Wind | North-up chart; boat speed + true wind → ground wind triangle |

### CSS classes for insight layout
```
.insight-layout        – flex container (body/main)
.insight-nav           – 200 px left column of step buttons
.insight-nav button    – step button; .active-step = selected (blue)
.insight-scene         – right area containing canvas + panel
.insight-scene-columns – flex row: canvas left, panel right
.insight-scene-canvas  – canvas wrapper
.insight-scene-panel   – text/control panel (right column)

Scene panel internals:
.scene-description     – grey introductory text paragraph
.scene-enable          – bold row containing the Enabled checkbox label
.scene-section-heading – small uppercase heading separating each panel section
.scene-table           – shared 2-column table used for settings, inputs and outputs
.scene-number-input    – 80 px wide number <input> (settings table)
.scene-text-input      – 180 px wide text <input> (settings table)
.scene-warnings        – red bulleted list for "cannot be activated" reasons
```

---

## 13. Stylesheet (`main.css`)

CSS custom properties (variables) define colours keyed by polar/delta id so that
`color` and `stroke` are automatically correct when vector rows/elements carry
their id as an HTML `id` attribute. Colour assignments:

| Variable | Colour | Used for |
|---|---|---|
| `--groundWind-color` | `#1976d262` semi-transparent blue | ground wind vector |

`.stale` class → `background-color: orangered` – applied to rows/elements whose
source data is missing or outdated.

---

## 14. Key architectural decisions and conventions

1. **Options are always flat at runtime.** The grouped schema is only for the
   Signal K admin UI. All reading and writing within `calculate()` uses flat
   keys such as `options.correctForMisalign`, `options.sensorMisalignment`.

2. **All inputs use Kalman smoothing.** The time constant is shared across all
   inputs and set via `parameters.timeConstant`.

3. **`apparentWind.onChange` is the heartbeat.** Every calculation cycle is
   triggered by a new apparent wind delta. Other values (heading, attitude, boat
   speed, etc.) are read from their last cached (smoothed) values.

4. **`passOn` controls duplication.** When `preventDuplication` is true,
   `apparentWind`'s handlers have `passOn = false`, meaning the raw apparent
   wind delta is consumed and not re-emitted. The plugin then writes back its
   own corrected value.

5. **Ground-plane vectors use a `0 to 2π` angle range**; boat-plane vectors use
   `−π to π`.

6. **The REST `/settings` PUT endpoint is additive.** It merges incoming keys into
   `changedOptions`, which are drained on the next `calculate()` call. Changes
   to correction flags take effect immediately (options are read inside
   `calculate()`). Changes to source strings and paths are applied via
   `applyOptionChanges()` which updates the live handler instances.

7. **`insight.js` uses ES module syntax** (`import`/`export` not used; it is
   loaded with `type="module"` for strict-mode isolation). All state is
   module-scoped.

---

## 15. Work still to do (as of March 2026)

- [ ] Implement individual canvas scenes in `insight.js` for each correction step
  (misalignment, mast heel, mast movement, upwash, leeway, height, ground wind).
- [ ] Implement the `/sources` endpoint to enumerate available Signal K sources
  per path (currently returns an empty list).
