const API_BASE_URL = "/plugins/advancedwind";

// Static metadata fetched once at startup — flat lookup keyed by item id.
let meta = {};

// reporter.meta() returns { polars: { id: {id, displayName, ...}, ... }, deltas: {...}, ... }
// Flatten all categories into a single id-keyed object for easy lookup.
function normaliseMeta(data) {
  const byId = {};
  for (const category of Object.values(data)) {
    if (category && typeof category === "object" && !Array.isArray(category)) {
      Object.assign(byId, category);
    }
  }
  return byId;
}

async function loadMeta() {
  try {
    const res = await fetch(`${API_BASE_URL}/meta`);
    if (res.ok) {
      meta = normaliseMeta(await res.json());
    } else {
      console.error("Failed to fetch meta", res.status, res.statusText);
    }
  } catch (err) {
    console.error("Error fetching meta", err);
  }
}

// SVG-based boat graphic (mirrors vectors.js approach)
let svgCanvas = null;

// Auto-scale state (exponential smoothing, same as vectors.js)
let _scalePrev = 0;
// SVG element IDs that were actually drawn in the most recent renderSVG call.
let _activeSvgIds = new Set();

function _getLargest(polars) {
  let largest = 1;
  polars.forEach(p => {
    largest = Math.max(largest, Math.abs(p.x || 0));
    largest = Math.max(largest, Math.abs(p.y || 0));
  });
  return largest;
}

function _smoothScale(largest) {
  if (_scalePrev === 0 || largest > _scalePrev) {
    _scalePrev = largest;        // snap out immediately so nothing clips
  } else {
    _scalePrev *= 0.9995;        // ease in slowly when vectors shrink
  }
  return 95 / _scalePrev;
}

function _svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function _drawBoat(svg, heading) {
  const hull = _svgEl("path", {
    d: "M -45 8  Q 15 20 30 0 Q 15 -20 -45 -8 z",
    fill: "none",
    stroke: "black",
    "stroke-width": "1",
    id: "hull"
  });
  const boat = _svgEl("g", { transform: `rotate(${heading - 90})` });
  boat.appendChild(hull);
  svg.appendChild(boat);
}

function _drawVectors(svg, polars, heading, scale) {
  polars.forEach(polar => {
    const vector = _svgEl("line", {
      x1: 0,
      y1: 0,
      x2: (polar.x || 0) * scale,
      y2: (polar.y || 0) * scale,
      id: polar.id
    });

    if (!polar.solid) {
      let dash;
      let s = scale * 5 / 1.94384 - 1;
      if (s > 50) {
        s = s / 5;
        dash = `1 1 ${s - 1} 1 ${s} 1 ${s} 1 ${s} 1 ${s - 1} 1 `;
      } else {
        dash = `1 1 ${s - 1} 1 ${s} 1 `;
      }
      vector.setAttribute("stroke-dasharray", dash);
      vector.setAttribute("stroke-dashoffset", "1");
    }

    const plane = polar.plane ?? meta[polar.id]?.plane;
    vector.setAttribute("transform",
      plane === "Ground" ? "rotate(-90)" : `rotate(${heading - 90})`);

    svg.appendChild(vector);
  });
}

// Compute derived polars and inject them into st.polarsById so they are treated
// identically to server-reported polars by the generic _buildScenePolars reader.
// Must be called after normaliseState and whenever config changes.
function _computeDerivedPolars(cfg, st) {
  const attObj = st.attitudesById["attitude.smoothed"];
  const roll  = attObj && attObj.value ? (attObj.value.roll  || 0) : 0;
  const pitch = attObj && attObj.value ? (attObj.value.pitch || 0) : 0;

  // heelVector: mast-tip displacement in SVG units — x=fore-aft (pitch), y=lateral (roll).
  // svgUnits:true means it bypasses wind scale and is drawn at scale=1.
  st.polarsById["heelVector"] = {
    id: "heelVector", x: Math.sin(pitch) * 112.5, y: Math.sin(roll) * 112.5,
    solid: true, plane: "Boat", svgUnits: true
  };

  // mastMoveVector derived polar is no longer needed: sensorSpeed is already in m/s
  // (wind units) and Boat-plane, so it is drawn directly at wind scale via svgRole.

  // boatSpeed: inject as a forward-pointing Boat-plane polar keyed under "boatSpeed.smoothed"
  // to match the descriptor id in stepConfigs; rendered with svgRole "boatSpeed".
  const bsDelta = st.deltasById["boatSpeed.smoothed"];
  const bsVal = bsDelta ? (bsDelta.value || 0) : 0;
  if (bsVal > 0) {
    st.polarsById["boatSpeed.smoothed"] = {
      id: "boatSpeed.smoothed", x: bsVal, y: 0, solid: false, plane: "Boat"
    };
  } else {
    delete st.polarsById["boatSpeed.smoothed"];
  }

  // windShiftFast / windShiftSlow: convert angle deltas to fixed-length ground-plane polars.
  // svgUnits:true bypasses wind scale; length is fixed at 90 SVG units (45% of 200-unit height).
  const WIND_SHIFT_LEN = 90;
  ["windShiftFast", "windShiftSlow"].forEach(key => {
    const d = st.deltasById[key];
    if (d && typeof d.value === "number") {
      st.polarsById[key] = {
        id: key, x: Math.cos(d.value) * WIND_SHIFT_LEN, y: Math.sin(d.value) * WIND_SHIFT_LEN,
        solid: true, plane: "Ground", svgUnits: true
      };
    } else {
      delete st.polarsById[key];
    }
  });
}

// Build the list of polar-like objects to show in the SVG for the current scene.
// Reads svgRole from stepConfigs descriptors (inputs, outputs, svgExtra).
// Polars are looked up from st.polarsById, which includes derived polars injected
// by _computeDerivedPolars. svgRole becomes the SVG element id (= CSS colour key).
function _buildScenePolars(stepId, cfg, st) {
  const scfg = stepConfigs[stepId];
  if (!scfg) return { polars: [] };

  const currentCfg = cfg || {};
  const inputs  = typeof scfg.inputs   === "function" ? scfg.inputs(currentCfg)   : (scfg.inputs   || []);
  const outputs = typeof scfg.outputs  === "function" ? scfg.outputs(currentCfg)  : (scfg.outputs  || []);
  const extra   = typeof scfg.svgExtra === "function" ? scfg.svgExtra(currentCfg) : (scfg.svgExtra || []);

  const polars = [];
  [...inputs, ...outputs, ...extra].forEach(item => {
    if (!item.svgRole) return;
    const src = st.polarsById[item.id];
    if (!src) return;
    // Alias id to svgRole so CSS colouring uses the role name.
    // Preserve plane from the source object; fall back to meta for the original id.
    polars.push({ ...src, id: item.svgRole, plane: src.plane ?? meta[item.id]?.plane });
  });

  return { polars };
}

function renderSVG() {
  const svg = document.getElementById("insight-canvas");
  if (!svg) return;
  svg.innerHTML = "";

  const cfg = config || {};
  const headingDelta = state.deltasById["heading.smoothed"];
  const heading = headingDelta ? headingDelta.value * 180 / Math.PI : 0;

  const { polars } = _buildScenePolars(currentStepId, cfg, state);

  // Polars with svgUnits:true are already in SVG units and bypass the wind scale.
  const windPolars = polars.filter(p => !p.svgUnits);
  const geoPolars  = polars.filter(p =>  p.svgUnits);

  let largest = _getLargest(windPolars);
  if (largest < 1) largest = 1;
  const scale = _smoothScale(largest);

  _activeSvgIds = new Set(polars.map(p => p.id));

  _drawBoat(svg, heading);
  _drawVectors(svg, windPolars, heading, scale);
  if (geoPolars.length) _drawVectors(svg, geoPolars, heading, 1);
}

let state = {
  polarsById: {},
  deltasById: {},
  attitudesById: {},
  tablesById: {}
};
let config = null;

// Navigation / steps
const steps = [
  { id: "overview",   label: "Overview" },
  { id: "inputs",     label: "Inputs" },
  { id: "misalign",   label: "Misalignment" },
  { id: "mastRot",    label: "Mast Rotation" },
  { id: "mastHeel",   label: "Mast Heel" },
  { id: "mastMove",   label: "Mast Movement" },
  { id: "upwash",     label: "Upwash" },
  { id: "leeway",     label: "Leeway" },
  { id: "trueWind",   label: "True Wind" },
  { id: "height",     label: "Height / 10m" },
  { id: "backCalc",   label: "Back Calc AW" },
  { id: "groundWind", label: "Wind direction" },
  { id: "windShift",  label: "Wind Shift" }
];

let currentStepId = "overview";

function setMessage(text) {
  const el = document.getElementById("message");
  if (el) {
    el.textContent = text || "";
  }
}

async function fetchReport() {
  try {
    const response = await fetch(`${API_BASE_URL}/report`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      if (response.status === 503) {
        setMessage("Plugin is not running. Enable the plugin.");
      } else if (response.status === 401) {
        setMessage("You are not logged on to the server. Log on to the server.");
      } else {
        setMessage(`Failed to fetch report: ${response.status} ${response.statusText}`);
      }
      return null;
    }

    setMessage("");
    const data = await response.json();
    return data;
  } catch (err) {
    console.error(err);
    setMessage(`Error fetching report: ${err.message}`);
    return null;
  }
}

async function fetchConfig() {
  try {
    const response = await fetch(`${API_BASE_URL}/settings`, {
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      // Config is nice-to-have; log but don't spam UI.
      console.error("Failed to fetch config", response.status, response.statusText);
      return;
    }

    config = await response.json();
  } catch (err) {
    console.error("Error fetching config", err);
  }
}

// Update helpers

// All config keys are flat (e.g. "correctForMisalign", "sensorMisalignment").
// The server stores and exposes options as a flat object.
async function updateConfigAtPath(key, value) {
  if (!key) return;

  try {
    const response = await fetch(`${API_BASE_URL}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value })
    });

    if (!response.ok) {
      console.error("Failed to update config", response.status, response.statusText);
      return;
    }

    // Server returns the full merged config — use it directly.
    config = await response.json();
    renderAll();
  } catch (err) {
    console.error("Error updating config", err);
  }
}

// reporter.report() returns { polars: { id: {id, value/magnitude/angle, state, ...}, ... }, deltas: {...}, ... }
function normaliseState(data) {
  state = {
    polarsById:    data.polars    || {},
    deltasById:    data.deltas    || {},
    attitudesById: data.attitudes || {},
    tablesById:    data.tables    || {},
  };
}

// --- Config helpers ---

// Config is a flat object; key is a plain option name such as "correctForMisalign".
function getConfigValue(key) {
  if (!config || !key) return undefined;
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined;
}

// --- Parameter metadata ---
// Provides label, unit and type for every flat config key.
// min/max/step for numeric params are served by the plugin via config._bounds —
// do not duplicate them here; createParamControl reads them from config._bounds.
const paramMeta = {
  sensorMisalignment:          { label: "Sensor misalignment",                                           unit: "°", type: "number" },
  heightAboveWater:            { label: "Sensor height above water",                                     unit: "m", type: "number" },
  windExponent:                { label: "Wind gradient exponent (α)",                                    unit: "",  type: "number" },
  upwashSlope:                 { label: "Upwash slope (α)",                                              unit: "",  type: "number" },
  upwashOffset:                { label: "Upwash offset (β)",                                             unit: "°", type: "number" },
  smootherClass:               { label: "Smoother type",                                                 unit: "",  type: "select",
    options: [
      { value: "KalmanSmoother",        label: "Kalman filter" },
      { value: "ExponentialSmoother",   label: "Exponential (τ)" },
      { value: "MovingAverageSmoother", label: "Moving Average (window)" },
      { value: "PassThroughSmoother",   label: "None (pass-through)" }
    ]
  },
  smootherTau:                 { label: "Time constant (τ)",                                              unit: "s", type: "number" },
  smootherTimeSpan:            { label: "Window size",                                                   unit: "s", type: "number" },
  smootherSteadyState:         { label: "Kalman gain (0 = ignore sensor, 1 = trust fully)",              unit: "",  type: "number" },
  attitudeSmootherClass:       { label: "Attitude smoother type",                                        unit: "",  type: "select",
    options: [
      { value: "MovingAverageSmoother", label: "Moving Average (window)" },
      { value: "ExponentialSmoother",   label: "Exponential (τ)" },
      { value: "KalmanSmoother",        label: "Kalman filter" },
      { value: "PassThroughSmoother",   label: "None (pass-through)" }
    ]
  },
  attitudeSmootherTau:         { label: "Attitude time constant (τ)",                                    unit: "s", type: "number" },
  attitudeSmootherTimeSpan:    { label: "Attitude window size",                                          unit: "s", type: "number" },
  attitudeSmootherSteadyState: { label: "Attitude Kalman gain",                                         unit: "",  type: "number" },
  rotationPath:                { label: "Mast rotation path",                                            unit: "",  type: "string" },
  stalenessDetection:          { label: "Staleness detection",                                           unit: "",  type: "boolean" },
  calculateGroundWind:         { label: "Calculate Wind direction",                                      unit: "",  type: "boolean" },
  backCalculateApparentWind:   { label: "Back-calculate apparent wind",                                  unit: "",  type: "boolean" },
  detectWindShift:             { label: "Detect wind shifts",                                            unit: "",  type: "boolean" },
  windShiftFastClass:          { label: "Fast smoother type",                                            unit: "",  type: "select",
    options: [
      { value: "ExponentialSmoother",   label: "Exponential (τ)" },
      { value: "MovingAverageSmoother", label: "Moving Average (window)" },
      { value: "KalmanSmoother",        label: "Kalman filter" },
      { value: "PassThroughSmoother",   label: "None (pass-through)" }
    ]
  },
  windShiftFastTau:            { label: "Fast time constant (τ)",                                        unit: "s", type: "number" },
  windShiftFastTimeSpan:       { label: "Fast window size",                                              unit: "s", type: "number" },
  windShiftFastSteadyState:    { label: "Fast Kalman gain",                                              unit: "",  type: "number" },
  windShiftSlowClass:          { label: "Slow smoother type",                                            unit: "",  type: "select",
    options: [
      { value: "ExponentialSmoother",   label: "Exponential (τ)" },
      { value: "MovingAverageSmoother", label: "Moving Average (window)" },
      { value: "KalmanSmoother",        label: "Kalman filter" },
      { value: "PassThroughSmoother",   label: "None (pass-through)" }
    ]
  },
  windShiftSlowTau:            { label: "Slow time constant (τ)",                                        unit: "s", type: "number" },
  windShiftSlowTimeSpan:       { label: "Slow window size",                                              unit: "s", type: "number" },
  windShiftSlowSteadyState:    { label: "Slow Kalman gain",                                              unit: "",  type: "number" },
};

// --- Step definitions ---
// inputs/outputs are arrays of { type: 'polar'|'delta'|'attitude', id }.
// parameters is an array of flat config key strings, OR objects of the form
//   { key: "configKey", showIf: (config) => boolean }
// for parameters that should only appear when a condition holds.
// correctionFlag is the flat config key for the enable/disable boolean, or null.
const stepConfigs = {
  overview: {
    description: "High-level view of the calculation pipeline: what goes in and what comes out.",
    correctionFlag: null,
    parameters: [],
    inputs: (cfg) => {
      const items = [
        { type: "polar", id: "apparentWind.smoothed", svgRole: "apparentWind" },
        { type: "delta", id: "boatSpeed.smoothed" }
      ];
      if (cfg.correctForMastHeel || cfg.correctForMastMovement || cfg.correctForHeight)
        items.push({ type: "attitude", id: "attitude.smoothed" });
      if (cfg.calculateGroundWind) {
        items.push({ type: "delta",  id: "heading.smoothed" });
        items.push({ type: "polar", id: "groundSpeed.smoothed" });
      }
      return items;
    },
    outputs: (cfg) => {
      const items = [ { type: "polar", id: "trueWind", svgRole: "trueWind" } ];
      if (cfg.backCalculateApparentWind)
        items.push({ type: "polar", id: "backCalcOut", svgRole: "correctedWind" });
      if (cfg.calculateGroundWind)
        items.push({ type: "polar", id: "groundWind", svgRole: "groundWind" });
      if (cfg.detectWindShift) {
        items.push({ type: "delta", id: "windShiftFast" });
        items.push({ type: "delta", id: "windShiftSlow" });
        items.push({ type: "delta", id: "windShift" });
      }
      return items;
    }
  },
  inputs: {
    description: "Start of the calculation pipeline. Raw samples are fed through a smoother before entering the calculations; choose the smoother type and tune its parameters below.",
    correctionFlag: null,
    parameters: [
      "rotationPath",
      "smootherClass",
      { key: "smootherTau",                 showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "ExponentialSmoother" },
      { key: "smootherTimeSpan",            showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "MovingAverageSmoother" },
      { key: "smootherSteadyState",         showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "KalmanSmoother" },
      // PassThroughSmoother has no parameters — nothing extra to show.
      "stalenessDetection",
    ],
    inputs: (cfg) => [
      { type: "polar",    id: "apparentWind.smoothed", svgRole: "apparentWind" },
      { type: "delta",    id: "boatSpeed.smoothed",    svgRole: "boatSpeed" },
      { type: "delta",    id: "heading.smoothed" },
      { type: "attitude", id: "attitude.smoothed",     svgRole: "heelVector" },
      { type: "delta",    id: "leeway.smoothed" },
      { type: "delta",    id: "mast.smoothed" },
      { type: "polar",    id: "groundSpeed.smoothed",  ...(cfg.calculateGroundWind ? { svgRole: "groundSpeed" } : {}) },
    ],
    svgExtra: [{ id: "heelVector", svgRole: "heelVector" }],
    outputs: []
  },
  misalign: {
    description: "Correct for a misaligned wind sensor.",
    correctionFlag: "correctForMisalign",
    parameters: ["sensorMisalignment"],
    inputs:  [
      { type: "polar", id: "misalignIn", svgRole: "apparentWind" }
    ],
    outputs: (cfg) => cfg.correctForMisalign
      ? [{ type: "polar", id: "misalignOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "misalignOut" }]
  },
  mastRot: {
    description: "Correct for a rotating mast.",
    correctionFlag: "correctForMastRotation",
    parameters: ["rotationPath"],
    inputs:  [
      { type: "polar", id: "mastRotIn", svgRole: "apparentWind" },
      { type: "delta", id: "mast.smoothed" }
    ],
    outputs: (cfg) => cfg.correctForMastRotation
      ? [{ type: "polar", id: "mastRotOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "mastRotOut" }]
  },
  mastHeel: {
    description: "Compensates for wind speed underreading caused by the sensor tilting with a heeled mast.",
    correctionFlag: "correctForMastHeel",
    parameters: [],
    inputs:  (cfg) => [
      { type: "polar",    id: "mastHeelIn",        svgRole: "apparentWind" },
      { type: "attitude", id: "attitude.smoothed", ...(cfg.correctForMastHeel ? { svgRole: "heelVector" } : {}) }
    ],
    outputs: (cfg) => cfg.correctForMastHeel
      ? [{ type: "polar", id: "mastHeelOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "mastHeelOut" }],
    svgExtra: (cfg) => cfg.correctForMastHeel
      ? [{ id: "heelVector", svgRole: "heelVector" }]
      : []
  },
  mastMove: {
    description: "Correct for mast movement due to waves.",
    correctionFlag: "correctForMastMovement",
    parameters: [
      "heightAboveWater",
      "attitudeSmootherClass",
      { key: "attitudeSmootherTau",         showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "ExponentialSmoother" },
      { key: "attitudeSmootherTimeSpan",    showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "MovingAverageSmoother" },
      { key: "attitudeSmootherSteadyState", showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "KalmanSmoother" },
    ],
    inputs:  (cfg) => [
      { type: "polar",    id: "mastMoveIn",        svgRole: "apparentWind" },
      { type: "attitude", id: "attitude.smoothed" },
      { type: "polar",    id: "sensorSpeed",       ...(cfg.correctForMastMovement ? { svgRole: "mastMoveVector" } : {}) }
    ],
    outputs: (cfg) => cfg.correctForMastMovement
      ? [{ type: "polar", id: "mastMoveOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "mastMoveOut" }],
    svgExtra: []
  },
  upwash: {
    description: "Correct for sail-induced upwash.",
    correctionFlag: "correctForUpwash",
    parameters: ["upwashSlope", "upwashOffset"],
    inputs:  [
      { type: "polar", id: "upwashIn", svgRole: "apparentWind" },
      { type: "delta", id: "upwashAngle" }
    ],
    outputs: (cfg) => cfg.correctForUpwash
      ? [{ type: "polar", id: "upwashOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "upwashOut" }]
  },
  leeway: {
    description: "Correct for leeway.",
    correctionFlag: "correctForLeeway",
    parameters: [],
    inputs:  [
      { type: "polar", id: "leewayIn", svgRole: "apparentWind" },
      { type: "delta", id: "leeway.smoothed" }
    ],
    outputs: (cfg) => cfg.correctForLeeway
      ? [{ type: "polar", id: "leewayOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "leewayOut" }]
  },
  trueWind: {
    description: "Calculates true wind by subtracting boat speed from apparent wind.",
    correctionFlag: null,
    parameters: [],
    inputs:  [
      { type: "polar", id: "trueWindIn",         svgRole: "apparentWind" },
      { type: "delta", id: "boatSpeed.smoothed", svgRole: "boatSpeed" }
    ],
    outputs: [{ type: "polar", id: "trueWind", svgRole: "trueWind" }]
  },
  height: {
    description: "Scales true wind speed to a reference height of 10 m as used in weather forecasts and in polars. Sensor height is first reduced by mast heel (roll/pitch) before applying the wind gradient.",
    correctionFlag: "correctForHeight",
    parameters: ["heightAboveWater", "windExponent"],
    inputs: (cfg) => {
      const items = [{ type: "polar", id: "heightIn", svgRole: "trueWind" }];
      if (cfg.correctForHeight)
        items.push({ type: "attitude", id: "attitude.smoothed", svgRole: "heelVector" });
      return items;
    },
    svgExtra: (cfg) => cfg.correctForHeight
      ? [{ id: "heelVector", svgRole: "heelVector" }]
      : [],
    outputs: (cfg) => cfg.correctForHeight
      ? [{ type: "polar", id: "heightOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "heightOut" }]
  },
  backCalc: {
    description: "Back-calculates apparent wind and sends it to SignalK.",
    correctionFlag: "backCalculateApparentWind",
    parameters: [],
    inputs:  [
      { type: "polar", id: "heightOut" },
      { type: "delta", id: "boatSpeed.smoothed", svgRole: "boatSpeed" }
    ],
    outputs: (cfg) => cfg.backCalculateApparentWind
      ? [{ type: "polar", id: "backCalcOut", svgRole: "correctedWind" }]
      : [{ type: "polar", id: "backCalcOut" }],
    svgExtra: [{ id: "trueWind", svgRole: "trueWind" }]
  },
  groundWind: {
    description: "Calculates wind direction (wind over ground).",
    correctionFlag: "calculateGroundWind",
    parameters: [],
    inputs:  [
      { type: "polar", id: "groundWindIn",        svgRole: "apparentWind" },
      { type: "polar", id: "groundSpeed.smoothed", svgRole: "groundSpeed" },
      { type: "delta", id: "heading.smoothed" }
    ],
    outputs: [{ type: "polar", id: "groundWind", svgRole: "groundWind" }]
  },
  windShift: {
    description: "Detects wind shifts by comparing a fast-responding mean ground wind to a slow reference mean.",
    correctionFlag: "detectWindShift",
    parameters: [
      "windShiftFastClass",
      { key: "windShiftFastTau",         showIf: cfg => (cfg.windShiftFastClass || "ExponentialSmoother") === "ExponentialSmoother" },
      { key: "windShiftFastTimeSpan",    showIf: cfg => (cfg.windShiftFastClass || "ExponentialSmoother") === "MovingAverageSmoother" },
      { key: "windShiftFastSteadyState", showIf: cfg => (cfg.windShiftFastClass || "ExponentialSmoother") === "KalmanSmoother" },
      "windShiftSlowClass",
      { key: "windShiftSlowTau",         showIf: cfg => (cfg.windShiftSlowClass || "ExponentialSmoother") === "ExponentialSmoother" },
      { key: "windShiftSlowTimeSpan",    showIf: cfg => (cfg.windShiftSlowClass || "ExponentialSmoother") === "MovingAverageSmoother" },
      { key: "windShiftSlowSteadyState", showIf: cfg => (cfg.windShiftSlowClass || "ExponentialSmoother") === "KalmanSmoother" },
    ],
    inputs: [
      { type: "polar", id: "groundWind", svgRole: "groundWind" }
    ],
    outputs: [
      { type: "delta", id: "windShiftFast", svgRole: "windShiftFast" },
      { type: "delta", id: "windShiftSlow", svgRole: "windShiftSlow" },
      { type: "delta", id: "windShift" }
    ]
  },
};


// --- Panel rendering helpers ---

function sceneSectionHeading(text) {
  const h = document.createElement("h6");
  h.className = "text-uppercase fw-bold text-muted border-bottom pb-1 mt-3 mb-1 small";
  h.textContent = text;
  return h;
}

// Return the live state object for a typed descriptor { type, id }.
function getStateItem(item) {
  switch (item.type) {
    case "polar":    return state.polarsById[item.id];
    case "delta":    return state.deltasById[item.id];
    case "attitude": return state.attitudesById[item.id];
    default:         return null;
  }
}

// Format a value in the given units to a human-readable string.
// Prefers SK displayUnits (user unit preferences from the server) when available.
// Falls back to default conversions (m/s → kn, rad → °) when absent.
function _parseDecimals(displayFormat) {
  if (!displayFormat) return 1;
  const dot = displayFormat.indexOf('.');
  return dot < 0 ? 0 : displayFormat.length - dot - 1;
}

function _formatUnit(value, displayUnits, rawUnits) {
  if (typeof value !== "number") return "—";
  // Default displayUnits by SI unit; SK server preferences override these.
  const defaults =
    rawUnits === "m/s"               ? { formula: "value * 1.943844",      symbol: "kn", displayFormat: "0.0" } :
    (!rawUnits || rawUnits === "rad") ? { formula: "value * 180 / Math.PI", symbol: "°",  displayFormat: "0.1" } :
                                        { formula: "value",                 symbol: rawUnits, displayFormat: "0.2" };
  const du = { ...defaults, ...displayUnits };
  // Formula is a Math.js expression from the trusted local SK server (e.g. "value * 1.94384").
  // eslint-disable-next-line no-new-func
  const converted = new Function('value', 'return ' + du.formula)(value);
  return converted.toFixed(_parseDecimals(du.displayFormat)) + ' ' + du.symbol;
}

// Format a live state object as a short readable string.
// Uses unit metadata from the static meta dict where available.
function formatStateValue(type, data) {
  if (!data) return "—";
  const m = meta[data.id];
  switch (type) {
    case "polar": {
      if (typeof data.magnitude !== "number" || typeof data.angle !== "number") return "—";
      const spd = _formatUnit(data.magnitude, m?.magnitude?.displayUnits, m?.magnitude?.units);
      const ang = _formatUnit(data.angle,     m?.angle?.displayUnits,     m?.angle?.units);
      return `${spd} / ${ang}`;
    }
    case "delta": {
      return _formatUnit(data.value, m?.displayUnits, m?.units);
    }
    case "attitude": {
      if (!data.value) return "—";
      // Attitude components (roll/pitch) are always radians; no SK path meta per component.
      const r = _formatUnit(data.value.roll,  null, "rad");
      const p = _formatUnit(data.value.pitch, null, "rad");
      return `roll ${r} / pitch ${p}`;
    }
    default: return "—";
  }
}

// Maps SVG element id (= svgRole) to the CSS custom property controlling its stroke colour.
// Used by createDataTable to look up the swatch colour from item.svgRole.
const _svgIdColorVar = {
  apparentWind:   "--apparentWind-color",
  correctedWind:  "--correctedWind-color",
  trueWind:       "--trueWind-color",
  groundWind:     "--groundWind-color",
  boatSpeed:      "--boatSpeed-color",
  groundSpeed:    "--groundSpeed-color",
  heelVector:     "--heelVector-color",
  mastMoveVector: "--mastMoveVector-color",
  windShiftFast:  "--windShiftFast-color",
  windShiftSlow:  "--windShiftSlow-color",
  windShift:      "--windShift-color",
};

// Build a 2-column table (Name | Value) for an array of typed descriptors.
function createDataTable(items) {
  const table = document.createElement("table");
  table.className = "table table-sm table-borderless mb-0";
  items.forEach(item => {
    const data = getStateItem(item);
    const row  = table.insertRow();
    if (isNotReady(data)) row.className = "not-ready";
    const nameCell = row.insertCell();
    nameCell.textContent = meta[item.id]?.displayName ?? item.id;
    const colorVar = item.svgRole && _activeSvgIds.has(item.svgRole) ? _svgIdColorVar[item.svgRole] : null;
    if (colorVar) {
      const swatch = document.createElement("span");
      swatch.className = "vector-swatch";
      swatch.style.backgroundColor = `var(${colorVar})`;
      nameCell.appendChild(swatch);
    }
    const valCell = row.insertCell();
    valCell.textContent = data ? formatStateValue(item.type, data) : "—";
  });
  return table;
}

// Build the interactive control for a single config parameter.
function createParamControl(key, meta, value, readOnly) {
  const container = document.createElement("span");
  if (meta.type === "boolean") {
    const lbl = document.createElement("label");
    lbl.className = "switch switch-text switch-primary";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "switch-input form-check-input";
    cb.id = "param-cb-" + key;
    cb.checked = !!value;
    cb.onchange = () => updateConfigAtPath(key, cb.checked);
    const switchLabel = document.createElement("span");
    switchLabel.className = "switch-label";
    switchLabel.setAttribute("data-on", "Yes");
    switchLabel.setAttribute("data-off", "No");
    const switchHandle = document.createElement("span");
    switchHandle.className = "switch-handle";
    lbl.appendChild(cb);
    lbl.appendChild(switchLabel);
    lbl.appendChild(switchHandle);
    container.appendChild(lbl);
  } else if (meta.type === "number") {
    const inp = document.createElement("input");
    inp.type  = "number";
    // min/max/step/displayFactor are served by the plugin in config._bounds.
    // displayFactor converts between internal (stored) units and display units.
    // e.g. sensorMisalignment is stored in radians but displayed in degrees.
    const bounds = config && config._bounds && config._bounds[key];
    const factor = (bounds && bounds.displayFactor) || 1;
    inp.value = value !== undefined ? value * factor : "";
    if (bounds) {
      if (bounds.step !== undefined) inp.step = bounds.step * factor;
      if (bounds.min  !== undefined) inp.min  = bounds.min  * factor;
      if (bounds.max  !== undefined) inp.max  = bounds.max  * factor;
    }
    inp.className = "form-control form-control-sm d-inline-block";
    inp.style.width = "80px";
    inp.onchange = () => updateConfigAtPath(key, parseFloat(inp.value) / factor);
    container.appendChild(inp);
  } else if (meta.type === "select") {
    const sel = document.createElement("select");
    sel.className = "form-select form-select-sm d-inline-block";
    sel.style.width = "200px";
    (meta.options || []).forEach(opt => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    sel.value = value !== undefined && value !== null ? value : (meta.options && meta.options[0] ? meta.options[0].value : "");
    sel.onchange = () => updateConfigAtPath(key, sel.value);
    container.appendChild(sel);
  } else {
    const inp = document.createElement("input");
    inp.type  = "text";
    inp.value = value !== undefined ? value : "";
    inp.className = "form-control form-control-sm d-inline-block";
    inp.style.width = "180px";
    inp.onchange = () => updateConfigAtPath(key, inp.value);
    container.appendChild(inp);
  }
  return container;
}

// Return true if a state item is not ready (absent or state.ready !== true).
function isNotReady(data) {
  if (!data) return true;
  return data.state?.ready !== true;
}

// Return a human-readable reason why a state item is not ready.
// Inspects the new state fields (subscribed, pathKnown, sourceNotFound, hasDelta, isStale)
// from signalkutilities. For smoothers these fields live under handler/magnitude/angle;
// for plain Polars they are at the top level.
function getNotReadyReason(data) {
  const s = data?.state;
  if (!s) return "no data";

  // Collect the sub-states that carry subscribed/pathKnown/sourceNotFound.
  // MessageSmoother / SmoothedAngle → s.handler
  // PolarSmoother → s.magnitude + s.angle
  // Plain Polar / MessageHandler → s itself
  const handlerStates = [];
  if (s.handler)    handlerStates.push(s.handler);
  if (s.magnitude)  handlerStates.push(s.magnitude);
  if (s.angle)      handlerStates.push(s.angle);
  if (handlerStates.length === 0) handlerStates.push(s);

  if (handlerStates.some(h => h.subscribed    === false)) return "not subscribed to Signal K";
  if (handlerStates.some(h => h.pathKnown     === false)) return "path not found in Signal K";
  if (handlerStates.some(h => h.sourceNotFound === true)) return "configured source not producing data";
  if (s.hasDelta === false)                               return "waiting for first data";
  if (s.isStale  === true)                                return "data is stale";
  return "not available";
}

// Collect human-readable reasons why a correction step's parameters are invalid.
// Input readiness is checked separately in renderPanelLive for all steps.
function getCannotActivateReasons(cfg) {
  const reasons = [];
  if (!cfg.correctionFlag) return reasons;

  // Check required parameters: numbers must be finite, non-source strings must be non-empty.
  (cfg.parameters || []).forEach(entry => {
    const key  = typeof entry === "string" ? entry : entry.key;
    const meta = paramMeta[key];
    if (!meta) return;
    // Booleans always have a valid value.
    if (meta.type === "boolean") return;

    const value = getConfigValue(key);
    if (meta.type === "number") {
      if (value === undefined || value === null || value === "" || !isFinite(Number(value))) {
        reasons.push(`"${meta.label}" is not set`);
      }
    } else if (meta.type === "string") {
      if (!value || String(value).trim() === "") {
        reasons.push(`"${meta.label}" is not set`);
      }
    }
  });

  return reasons;
}

// Sections 1-4: title, description, enable toggle, settings.
// Updates fixed placeholder elements; never touches live sections.
function renderPanel(step) {
  const titleEl       = document.getElementById("insight-title");
  const descEl        = document.getElementById("panel-description");
  const enableEl      = document.getElementById("panel-enable");
  const settingsEl    = document.getElementById("panel-settings");
  const sourcesEl     = document.getElementById("panel-sources");
  if (!descEl) return;

  // 1. Title
  if (titleEl) titleEl.textContent = step.label;

  const cfg = stepConfigs[step.id];
  if (!cfg) return;

  // 2. Description
  descEl.textContent = cfg.description || "";

  // 3. Enable checkbox
  enableEl.innerHTML = "";
  if (cfg.correctionFlag) {
    const lbl = document.createElement("label");
    lbl.className = "switch switch-text switch-primary";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "switch-input form-check-input";
    cb.id = "enable-cb-" + step.id;
    cb.checked = !!getConfigValue(cfg.correctionFlag);
    cb.onchange = () => updateConfigAtPath(cfg.correctionFlag, cb.checked);
    const switchLabel = document.createElement("span");
    switchLabel.className = "switch-label";
    switchLabel.setAttribute("data-on", "On");
    switchLabel.setAttribute("data-off", "Off");
    const switchHandle = document.createElement("span");
    switchHandle.className = "switch-handle";
    lbl.appendChild(cb);
    lbl.appendChild(switchLabel);
    lbl.appendChild(switchHandle);
    const wrapper = document.createElement("div");
    wrapper.className = "mb-2";
    wrapper.appendChild(lbl);
    enableEl.appendChild(wrapper);
  }

  // 4. Settings & Sources — split by param type
  settingsEl.innerHTML = "";
  if (sourcesEl) sourcesEl.innerHTML = "";

  const activeParams = (cfg.parameters || []).filter(entry => {
    if (typeof entry === "string") return true;
    return entry.showIf ? entry.showIf(config || {}) : true;
  });

  const settingParams = activeParams.filter(entry => {
    const key  = typeof entry === "string" ? entry : entry.key;
    const meta = paramMeta[key];
    return meta && meta.type !== "string";
  });

  const sourceParams = activeParams.filter(entry => {
    const key  = typeof entry === "string" ? entry : entry.key;
    const meta = paramMeta[key];
    return !meta || meta.type === "string";
  });

  function buildParamTable(params, readOnly) {
    const table = document.createElement("table");
    table.className = "table table-sm table-borderless mb-0";
    params.forEach(entry => {
      const key      = typeof entry === "string" ? entry : entry.key;
      const meta     = paramMeta[key] || { label: key, type: "string", unit: "" };
      const value    = getConfigValue(key);
      const row      = table.insertRow();
      const nameCell = row.insertCell();
      const rowLabel = meta.path || meta.label;
      nameCell.textContent = meta.unit ? `${rowLabel} (${meta.unit})` : rowLabel;
      const valCell  = row.insertCell();
      valCell.appendChild(createParamControl(key, meta, value, readOnly));
      const bounds = config && config._bounds && config._bounds[key];
      const boundsDefault = bounds && bounds.default;
      if (boundsDefault !== undefined && value !== boundsDefault) {
        const factor = (bounds && bounds.displayFactor) || 1;
        const btn = document.createElement("button");
        btn.className = "btn btn-link btn-sm p-0 ms-1";
        btn.title = `Reset to default (${boundsDefault * factor})`;
        btn.textContent = "↺";
        btn.onclick = () => updateConfigAtPath(key, boundsDefault);  // send in internal units
        valCell.appendChild(btn);
      }
    });
    return table;
  }

  if (settingParams.length > 0) {
    settingsEl.appendChild(sceneSectionHeading("Settings"));
    settingsEl.appendChild(buildParamTable(settingParams));
  }

  const sourcesReadOnly = step.id !== "inputs";
  if (sourcesEl && sourceParams.length > 0) {
    sourcesEl.appendChild(sceneSectionHeading("Sources"));
    sourcesEl.appendChild(buildParamTable(sourceParams, sourcesReadOnly));
  }
}

// Sections 5-7: real-time inputs, outputs, warnings.
// Updates fixed placeholder elements; never touches settings.
function renderPanelLive(step) {
  const inputsEl   = document.getElementById("panel-inputs");
  const outputsEl  = document.getElementById("panel-outputs");
  const warningsEl = document.getElementById("panel-warnings");
  if (!inputsEl) return;

  const cfg = stepConfigs[step.id];
  // inputs/outputs may be a static array or a function(config) => array
  const currentCfg = config || {};
  const cfgInputs  = cfg && (typeof cfg.inputs  === "function" ? cfg.inputs(currentCfg)  : cfg.inputs);
  const cfgOutputs = cfg && (typeof cfg.outputs === "function" ? cfg.outputs(currentCfg) : cfg.outputs);

  // 5. Inputs
  inputsEl.innerHTML = "";
  if (cfgInputs && cfgInputs.length > 0) {
    inputsEl.appendChild(sceneSectionHeading("Inputs"));
    inputsEl.appendChild(createDataTable(cfgInputs));
  }

  // 6. Outputs
  outputsEl.innerHTML = "";
  if (cfgOutputs && cfgOutputs.length > 0) {
    outputsEl.appendChild(sceneSectionHeading("Outputs"));
    outputsEl.appendChild(createDataTable(cfgOutputs));
  }

  // 7. Warnings — check all configured inputs for readiness across all steps.
  warningsEl.innerHTML = "";
  const notReadyReasons = [];
  (cfgInputs || []).forEach(item => {
    const data = getStateItem(item);
    if (isNotReady(data)) {
      const label = meta[item.id]?.displayName ?? item.id;
      notReadyReasons.push(`"${label}" — ${getNotReadyReason(data)}`);
    }
  });
  // For correction steps also validate required parameters.
  if (cfg && cfg.correctionFlag) {
    notReadyReasons.push(...getCannotActivateReasons(cfg));
  }
  if (notReadyReasons.length > 0) {
    warningsEl.appendChild(sceneSectionHeading("Warnings"));
    const list = document.createElement("ul");
    list.className = "list-unstyled text-danger small ps-3";
    notReadyReasons.forEach(r => {
      const li = document.createElement("li");
      li.textContent = r;
      list.appendChild(li);
    });
    warningsEl.appendChild(list);
  }
}

function buildNav() {
  const nav = document.getElementById("insight-nav");
  if (!nav) return;
  nav.innerHTML = "";

  steps.forEach(step => {
    const li = document.createElement("li");
    li.className = "nav-item";
    const a = document.createElement("a");
    a.className = "nav-link" + (step.id === currentStepId ? " active" : "");
    a.href = "#";
    a.textContent = step.label;
    a.onclick = (e) => {
      e.preventDefault();
      currentStepId = step.id;
      _scalePrev = 0;
      renderAll();
    };
    li.appendChild(a);
    nav.appendChild(li);
  });
}

// Fast path: called on every state poll.
// Only updates the SVG graphic and live data sections (inputs/outputs/warnings).
// Never touches interactive controls (checkboxes, number inputs, dropdowns).
function render() {
  const step = steps.find(s => s.id === currentStepId) || steps[0];
  renderSVG();
  renderPanelLive(step);
}

// Full render: rebuilds nav, all panel sections, and SVG graphic.
// Call this when the active step changes or after a config change.
function renderAll() {
  _computeDerivedPolars(config || {}, state);
  const step = steps.find(s => s.id === currentStepId) || steps[0];
  buildNav();
  renderSVG();
  renderPanel(step);
  renderPanelLive(step);
}

async function tick() {
  const data = await fetchReport();
  if (!data) {
    // A failed fetch may mean the server restarted; re-sync config in case it changed,
    // then refresh the settings panel so controls reflect the new config.
    await fetchConfig();
    renderAll();
    return;
  }
  normaliseState(data);
  _computeDerivedPolars(config || {}, state);
  render();
}

async function start() {
  await loadMeta();
  await fetchConfig();
  renderAll();
  await tick();
  setInterval(tick, 100);
}

window.addEventListener("DOMContentLoaded", () => {
  start();
});
