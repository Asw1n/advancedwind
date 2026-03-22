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

// Build the list of polar-like objects to show in the SVG for the current scene.
// Returns { polars: [...], showBoatSpeed: bool }.
// id on each object controls CSS colour; aliasing reuses existing colour rules.
function _buildScenePolars(stepId, cfg, st) {
  const pb = st.polarsById;
  // Clone a polar with a different id for colour mapping.
  // Preserve plane from meta keyed by the original id, since report() doesn't include it
  // and after aliasing meta[newId] won't find it.
  const as = (src, id) => src ? { ...src, id, plane: src.plane ?? meta[src.id]?.plane } : null;
  const ok = arr => arr.filter(Boolean);

  // Geometry-based heel and mastMove vectors (bypass wind scale).
  // heelVector: mast tip displacement = sin(pitch)×112.5 fore-aft, sin(roll)×112.5 lateral.
  // mastMoveVector: sensor velocity (m/s) scaled to SVG units via mast height.
  const mastH = (cfg && cfg.heightAboveWater) || 18;
  const svgPerMetre = 112.5 / mastH;
  const attObj = st.attitudesById["attitude.smoothed"];
  const roll  = attObj && attObj.value ? (attObj.value.roll  || 0) : 0;
  const pitch = attObj && attObj.value ? (attObj.value.pitch || 0) : 0;

  switch (stepId) {
    case "overview": {
      const list = [];
      // Suppress apparentWind when back-calc replaces it in SK.
      if (!(cfg.backCalculateApparentWind && cfg.preventDuplication))
        list.push(as(pb["apparentWind.smoothed"], "apparentWind"));
      list.push(pb.trueWind);
      if (cfg.backCalculateApparentWind) list.push(as(pb.backCalcOut, "correctedWind"));
      if (cfg.calculateGroundWind)       list.push(pb.groundWind);
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "inputs": {
      const list = [as(pb["apparentWind.smoothed"], "apparentWind")];
      if (cfg.calculateGroundWind) list.push(as(pb["groundSpeed.smoothed"], "groundSpeed"));
      const geo = [];
      geo.push({ id: "heelVector", x: Math.sin(pitch) * 112.5, y: Math.sin(roll) * 112.5,
                 solid: true, plane: "Boat" });
      return { polars: ok(list), geoPolars: ok(geo), showBoatSpeed: true };
    }
    case "misalign": {
      const list = [as(pb.misalignIn, "apparentWind")];
      if (cfg.correctForMisalign)     list.push(as(pb.misalignOut, "correctedWind"));
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "mastRot": {
      const list = [as(pb.mastRotIn, "apparentWind")];
      if (cfg.correctForMastRotation) list.push(as(pb.mastRotOut, "correctedWind"));
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "mastHeel": {
      const list = [as(pb.mastHeelIn, "apparentWind")];
      const geo = [];
      if (cfg.correctForMastHeel) {
        list.push(as(pb.mastHeelOut, "correctedWind"));
        // Geometry-based: mast tip displacement from roll (lateral) and pitch (fore-aft).
        // x = sin(pitch)×112.5, y = sin(roll)×112.5 SVG units (mast height cancels).
        geo.push({ id: "heelVector", x: Math.sin(pitch) * 112.5, y: Math.sin(roll) * 112.5,
                   solid: true, plane: "Boat" });
      }
      return { polars: ok(list), geoPolars: ok(geo), showBoatSpeed: false };
    }
    case "mastMove": {
      const list = [as(pb.mastMoveIn, "apparentWind")];
      const geo = [];
      if (cfg.correctForMastMovement) {
        list.push(as(pb.mastMoveOut, "correctedWind"));
        if (pb.sensorSpeed) {
          // sensorSpeed is in m/s; scale to SVG units via mast height.
          geo.push({ id: "mastMoveVector",
                     x: (pb.sensorSpeed.x || 0) * svgPerMetre,
                     y: (pb.sensorSpeed.y || 0) * svgPerMetre,
                     solid: true, plane: "Boat" });
        }
      }
      return { polars: ok(list), geoPolars: ok(geo), showBoatSpeed: false };
    }
    case "upwash": {
      const list = [as(pb.upwashIn, "apparentWind")];
      if (cfg.correctForUpwash) list.push(as(pb.upwashOut, "correctedWind"));
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "leeway": {
      const list = [as(pb.leewayIn, "apparentWind")];
      if (cfg.correctForLeeway) list.push(as(pb.leewayOut, "correctedWind"));
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "trueWind": {
      // trueWindIn = corrected apparent wind entering true-wind step
      const list = [as(pb.trueWindIn, "apparentWind"), pb.trueWind];
      return { polars: ok(list), geoPolars: [], showBoatSpeed: true };
    }
    case "height": {
      // heightIn = trueWind before height scaling; trueWind = after scaling (in place)
      const list = [as(pb.heightIn, "trueWind")];
      if (cfg.correctForHeight) list.push(as(pb.heightOut, "correctedWind"));
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "backCalc": {
      const list = [pb.trueWind, as(pb.backCalcOut, "correctedWind")];
      return { polars: ok(list), geoPolars: [], showBoatSpeed: true };
    }
    case "groundWind": {
      const list = [as(pb.groundWindIn, "apparentWind"), as(pb["groundSpeed.smoothed"], "groundSpeed"), pb.groundWind];
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "windShift": {
      // windShiftFast and windShiftSlow are angle deltas — build unit-length polars for the SVG.
      const toUnit = (d) => d && typeof d.value === 'number'
        ? { id: d.id, x: Math.cos(d.value), y: Math.sin(d.value), solid: true, plane: 'Ground' }
        : null;
      const fast = st.deltasById['windShiftFast'];
      const slow = st.deltasById['windShiftSlow'];
      return { polars: ok([toUnit(fast), toUnit(slow)]), geoPolars: [], showBoatSpeed: false };
    }
    default:
      return { polars: ok([pb["apparentWind.smoothed"], pb.trueWind]), geoPolars: [], showBoatSpeed: false };
  }
}

function renderSVG() {
  const svg = document.getElementById("insight-canvas");
  if (!svg) return;
  svg.innerHTML = "";

  const cfg = config || {};
  const headingDelta = state.deltasById["heading.smoothed"];
  const heading = headingDelta ? headingDelta.value * 180 / Math.PI : 0;

  const { polars, geoPolars, showBoatSpeed } = _buildScenePolars(currentStepId, cfg, state);

  // boatSpeed: include in scale even when drawn separately.
  const boatSpeedDelta = state.deltasById["boatSpeed.smoothed"];
  const boatSpeedVal   = showBoatSpeed && boatSpeedDelta ? (boatSpeedDelta.value || 0) : 0;

  // Wind polars drive the auto-scale; geometry polars (heelVector, mastMoveVector)
  // are already in SVG units and bypass the wind scale (drawn at scale=1).
  let largest = Math.max(_getLargest(polars), Math.abs(boatSpeedVal));
  if (largest < 1) largest = 1;
  const scale = _smoothScale(largest);

  _drawBoat(svg, heading);
  _drawVectors(svg, polars, heading, scale);
  if (geoPolars && geoPolars.length) _drawVectors(svg, geoPolars, heading, 1);

  // Draw boatSpeed as a pure forward (no leeway) dashed vector.
  if (showBoatSpeed && boatSpeedVal > 0) {
    const len = boatSpeedVal * scale;
    let dash;
    let s = scale * 5 / 1.94384 - 1;
    if (s > 50) {
      s = s / 5;
      dash = `1 1 ${s - 1} 1 ${s} 1 ${s} 1 ${s} 1 ${s - 1} 1 `;
    } else {
      dash = `1 1 ${s - 1} 1 ${s} 1 `;
    }
    const v = _svgEl("line", {
      x1: 0, y1: 0,
      x2: len, y2: 0,
      id: "boatSpeed",
      "stroke-dasharray": dash,
      "stroke-dashoffset": "1",
      transform: `rotate(${heading - 90})`
    });
    svg.appendChild(v);
  }
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
  headingSource:               { label: "Heading source",       path: "navigation.headingTrue",          unit: "",  type: "string", sourceOf: { type: "delta",    id: "heading.smoothed" } },
  attitudeSource:              { label: "Attitude source",      path: "navigation.attitude",             unit: "",  type: "string", sourceOf: { type: "attitude", id: "attitude.smoothed" } },
  boatSpeedSource:             { label: "Boat speed source",    path: "navigation.speedThroughWater",    unit: "",  type: "string", sourceOf: { type: "delta",    id: "boatSpeed.smoothed" } },
  leewaySource:                { label: "Leeway angle source",  path: "navigation.leewayAngle",          unit: "",  type: "string", sourceOf: { type: "delta",    id: "leeway.smoothed" } },
  windSpeedSource:             { label: "Wind speed source",    path: "environment.wind.speedApparent",  unit: "",  type: "string", sourceOf: { type: "polar",    id: "apparentWind.smoothed" } },
  rotationPath:                { label: "Mast rotation path",                                            unit: "",  type: "string" },
  rotationSource:              { label: "Mast rotation source", path: "(see rotation path above)",       unit: "",  type: "string", sourceOf: { type: "delta",    id: "mast.smoothed" } },
  groundSpeedSource:           { label: "Ground speed source",  path: "navigation.speedOverGround",      unit: "",  type: "string", sourceOf: { type: "polar",    id: "groundSpeed.smoothed" } },
  calculateGroundWind:         { label: "Calculate Wind direction",                                      unit: "",  type: "boolean" },
  backCalculateApparentWind:   { label: "Back-calculate apparent wind",                                  unit: "",  type: "boolean" },
  preventDuplication:          { label: "Replace apparent wind (prevent duplication)",                   unit: "",  type: "boolean" },
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
        { type: "polar", id: "apparentWind.smoothed" },
        { type: "delta", id: "boatSpeed.smoothed" }
      ];
      if (cfg.correctForMastHeel || cfg.correctForMastMovement)
        items.push({ type: "attitude", id: "attitude.smoothed" });
      if (cfg.calculateGroundWind) {
        items.push({ type: "delta",  id: "heading.smoothed" });
        items.push({ type: "polar", id: "groundSpeed.smoothed" });
      }
      return items;
    },
    outputs: (cfg) => {
      const items = [ { type: "polar", id: "trueWind" } ];
      if (cfg.backCalculateApparentWind)
        items.push({ type: "polar", id: "backCalcOut" });
      if (cfg.calculateGroundWind)
        items.push({ type: "polar", id: "groundWind" });
      return items;
    }
  },
  inputs: {
    description: "Start of the calculation pipeline. All incoming Signal K paths are listed here — each can be filtered to a specific source. Raw samples are fed through a smoother before entering the calculations; choose the smoother type and tune its parameters below.",
    correctionFlag: null,
    parameters: [
      "windSpeedSource",
      "boatSpeedSource",
      "headingSource",
      "attitudeSource",
      "leewaySource",
      "rotationPath",
      "rotationSource",
      "groundSpeedSource",
      "smootherClass",
      { key: "smootherTau",                 showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "ExponentialSmoother" },
      { key: "smootherTimeSpan",            showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "MovingAverageSmoother" },
      { key: "smootherSteadyState",         showIf: cfg => (cfg.smootherClass || "ExponentialSmoother") === "KalmanSmoother" },
      // PassThroughSmoother has no parameters — nothing extra to show.
    ],
    inputs: [
      { type: "polar",    id: "apparentWind.smoothed" },
      { type: "delta",    id: "boatSpeed.smoothed" },
      { type: "delta",    id: "heading.smoothed" },
      { type: "attitude", id: "attitude.smoothed" },
      { type: "delta",    id: "leeway.smoothed" },
      { type: "delta",    id: "mast.smoothed" },
      { type: "polar",    id: "groundSpeed.smoothed" },
    ],
    outputs: []
  },
  misalign: {
    description: "Correct for a misaligned wind sensor.",
    correctionFlag: "correctForMisalign",
    parameters: ["sensorMisalignment"],
    inputs:  [
      { type: "polar", id: "misalignIn" }
    ],
    outputs: [
      { type: "polar", id: "misalignOut" }
    ]
  },
  mastRot: {
    description: "Correct for a rotating mast.",
    correctionFlag: "correctForMastRotation",
    parameters: ["rotationPath", "rotationSource"],
    inputs:  [
      { type: "polar", id: "mastRotIn" },
      { type: "delta", id: "mast.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "mastRotOut" }
    ]
  },
  mastHeel: {
    description: "Compensates for wind speed underreading caused by the sensor tilting with a heeled mast.",
    correctionFlag: "correctForMastHeel",
    parameters: ["attitudeSource"],
    inputs:  [
      { type: "polar",    id: "mastHeelIn" },
      { type: "attitude", id: "attitude.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "mastHeelOut" }
    ]
  },
  mastMove: {
    description: "Correct for mast movement due to waves.",
    correctionFlag: "correctForMastMovement",
    parameters: [
      "heightAboveWater",
      "attitudeSource",
      "attitudeSmootherClass",
      { key: "attitudeSmootherTau",         showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "ExponentialSmoother" },
      { key: "attitudeSmootherTimeSpan",    showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "MovingAverageSmoother" },
      { key: "attitudeSmootherSteadyState", showIf: cfg => (cfg.attitudeSmootherClass || "MovingAverageSmoother") === "KalmanSmoother" },
    ],
    inputs:  [
      { type: "polar",    id: "mastMoveIn" },
      { type: "attitude", id: "attitude.smoothed" },
      { type: "polar",    id: "sensorSpeed" }
    ],
    outputs: [
      { type: "polar", id: "mastMoveOut" }
    ]
  },
  upwash: {
    description: "Correct for sail-induced upwash.",
    correctionFlag: "correctForUpwash",
    parameters: ["upwashSlope", "upwashOffset"],
    inputs:  [
      { type: "polar", id: "upwashIn" },
      { type: "delta", id: "upwashAngle" }
    ],
    outputs: [
      { type: "polar", id: "upwashOut" }
    ]
  },
  leeway: {
    description: "Correct for leeway.",
    correctionFlag: "correctForLeeway",
    parameters: ["leewaySource"],
    inputs:  [
      { type: "polar", id: "leewayIn" },
      { type: "delta", id: "leeway.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "leewayOut" }
    ]
  },
  trueWind: {
    description: "Calculates true wind by subtracting boat speed from apparent wind.",
    correctionFlag: null,
    parameters: ["boatSpeedSource"],
    inputs:  [
      { type: "polar", id: "trueWindIn" },
      { type: "delta", id: "boatSpeed.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "trueWind" }
    ]
  },
  height: {
    description: "Scales true wind speed to a reference height of 10 m as used in weather forecasts and in polars.",
    correctionFlag: "correctForHeight",
    parameters: ["heightAboveWater", "windExponent"],
    inputs:  [
      { type: "polar", id: "heightIn" }
    ],
    outputs: [
      { type: "polar", id: "heightOut" }
    ]
  },
  backCalc: {
    description: "Back-calculates apparent wind and sends it to SignalK.",
    correctionFlag: "backCalculateApparentWind",
    parameters: [
      "preventDuplication"
    ],
    inputs:  [
      { type: "polar", id: "heightOut" },
      { type: "delta", id: "boatSpeed.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "backCalcOut" }
    ]
  },
  groundWind: {
    description: "Calculates wind direction (wind over ground).",
    correctionFlag: "calculateGroundWind",
    parameters: ["groundSpeedSource", "headingSource"],
    inputs:  [
      { type: "polar", id: "groundWindIn" },
      { type: "polar", id: "groundSpeed.smoothed" },
      { type: "delta", id: "heading.smoothed" }
    ],
    outputs: [
      { type: "polar", id: "groundWind" }
    ]
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
      { type: "polar", id: "groundWind" }
    ],
    outputs: [
      { type: "delta", id: "windShiftFast" },
      { type: "delta", id: "windShiftSlow" },
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

// Build a 2-column table (Name | Value) for an array of typed descriptors.
function createDataTable(items) {
  const table = document.createElement("table");
  table.className = "table table-sm table-borderless mb-0";
  items.forEach(item => {
    const data = getStateItem(item);
    const row  = table.insertRow();
    if (isStale(data)) row.className = "stale";
    const nameCell = row.insertCell();
    nameCell.textContent = meta[item.id]?.displayName ?? item.id;
    const valCell = row.insertCell();
    valCell.textContent = data ? formatStateValue(item.type, data) : "—";
  });
  return table;
}

// Build the interactive control for a single config parameter.
// readOnly: when true, source (sourceOf) params are displayed as plain text.
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
  } else if (meta.sourceOf) {
    if (readOnly) {
      // Display-only: show the current source value as plain text.
      const span = document.createElement("span");
      span.className = "form-control-plaintext form-control-sm d-inline-block";
      span.style.width = "180px";
      span.textContent = value || "(any)";
      container.appendChild(span);
    } else {
      // Source selector: build a <select> from the sources array on the state item.
      const sel = document.createElement("select");
      sel.className = "form-select form-select-sm d-inline-block";
      sel.style.width = "180px";
      // Always offer an empty option meaning "any source / no filter".
      const blankOpt = document.createElement("option");
      blankOpt.value = "";
      blankOpt.textContent = "(any)";
      sel.appendChild(blankOpt);
      // Populate from the state item's sources array.
      // All smoother types (MessageSmoother, PolarSmoother) expose sources at state.sources.
      const stateItem = getStateItem(meta.sourceOf);
      let sources = [];
      if (stateItem && stateItem.state) {
        sources = stateItem.state.sources ?? [];
      }
      sources.forEach(src => {
        const opt = document.createElement("option");
        opt.value = src;
        opt.textContent = src;
        sel.appendChild(opt);
      });
      sel.value = value || "";
      sel.onchange = () => updateConfigAtPath(key, sel.value);
      container.appendChild(sel);
    }
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

// Return true if a state item is considered stale / unavailable.
function isStale(data) {
  if (!data) return true;
  if (data.state?.stale === true) return true;
  return false;
}

// Collect human-readable reasons why a correction cannot currently be activated.
function getCannotActivateReasons(cfg) {
  const reasons = [];
  if (!cfg.correctionFlag) return reasons;

  // Check required input state items (polars, deltas, attitudes).
  (cfg.inputs || []).forEach(item => {
    const data = getStateItem(item);
    if (!data) {
      reasons.push(`No data available for "${item.id}"`);
    } else if (isStale(data)) {
      const label = meta[item.id]?.displayName ?? item.id;
      reasons.push(`"${label}" data is stale or missing`);
    }
  });

  // Check required parameters: numbers must be finite, non-source strings must be non-empty.
  (cfg.parameters || []).forEach(entry => {
    const key  = typeof entry === "string" ? entry : entry.key;
    const meta = paramMeta[key];
    if (!meta) return;
    // Source dropdowns are optional — "(any)" means accept all sources.
    if (meta.sourceOf) return;
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

  // 7. Warnings
  warningsEl.innerHTML = "";
  if (cfg && cfg.correctionFlag) {
    // Correction steps: show reasons the correction cannot run.
    const reasons = getCannotActivateReasons(cfg);
    if (reasons.length > 0) {
      warningsEl.appendChild(sceneSectionHeading("Missing"));
      const list = document.createElement("ul");
      list.className = "list-unstyled text-danger small ps-3";
      reasons.forEach(r => {
        const li = document.createElement("li");
        li.textContent = r;
        list.appendChild(li);
      });
      warningsEl.appendChild(list);
    }
  } else if (cfgInputs && cfgInputs.length > 0) {
    // Non-correction steps (e.g. overview): list any stale or missing inputs.
    const missing = [];
    cfgInputs.forEach(item => {
      const data = getStateItem(item);
      if (!data) {
        missing.push(`"${item.id}" — no data available`);
      } else if (isStale(data)) {
        const label = meta[item.id]?.displayName ?? item.id;
        missing.push(`"${label}" — data is stale or missing`);
      }
    });
    if (missing.length > 0) {
      warningsEl.appendChild(sceneSectionHeading("Missing:"));
      const list = document.createElement("ul");
      list.className = "list-unstyled text-danger small ps-3";
      missing.forEach(r => {
        const li = document.createElement("li");
        li.textContent = r;
        list.appendChild(li);
      });
      warningsEl.appendChild(list);
    }
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
