const API_BASE_URL = "/plugins/advancedwind";

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

    const plane = polar.displayAttributes && polar.displayAttributes.plane;
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
  const as = (src, id) => src ? { ...src, id } : null;
  const ok = arr => arr.filter(Boolean);

  // Geometry-based heel and mastMove vectors (bypass wind scale).
  // heelVector: mast tip displacement = sin(pitch)×112.5 fore-aft, sin(roll)×112.5 lateral.
  // mastMoveVector: sensor velocity (m/s) scaled to SVG units via mast height.
  const mastH = (cfg && cfg.heightAboveWater) || 18;
  const svgPerMetre = 112.5 / mastH;
  const attObj = st.attitudesById["attitude"];
  const roll  = attObj && attObj.value ? (attObj.value.roll  || 0) : 0;
  const pitch = attObj && attObj.value ? (attObj.value.pitch || 0) : 0;

  switch (stepId) {
    case "overview": {
      const list = [];
      // Suppress apparentWind when back-calc replaces it in SK.
      if (!(cfg.backCalculateApparentWind && cfg.preventDuplication))
        list.push(pb.apparentWind);
      list.push(pb.trueWind);
      if (cfg.backCalculateApparentWind) list.push(as(pb.backCalcOut, "correctedWind"));
      if (cfg.calculateGroundWind)       list.push(pb.groundWind);
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "inputs":
      return { polars: ok([pb.apparentWind]), geoPolars: [], showBoatSpeed: false };
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
                   solid: true, displayAttributes: { plane: "Boat" } });
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
                     solid: true, displayAttributes: { plane: "Boat" } });
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
      const list = [as(pb.groundWindIn, "apparentWind"), pb.groundSpeed, pb.groundWind];
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    case "outputs": {
      const list = [pb.trueWind];
      if (cfg.backCalculateApparentWind) list.push(as(pb.backCalcOut, "correctedWind"));
      if (cfg.calculateGroundWind)       list.push(pb.groundWind);
      return { polars: ok(list), geoPolars: [], showBoatSpeed: false };
    }
    default:
      return { polars: ok([pb.apparentWind, pb.trueWind]), geoPolars: [], showBoatSpeed: false };
  }
}

function renderSVG() {
  const svg = document.getElementById("insight-canvas");
  if (!svg) return;
  svg.innerHTML = "";

  const cfg = config || {};
  const headingDelta = state.deltasById["heading"];
  const heading = headingDelta ? headingDelta.value * 180 / Math.PI : 0;

  const { polars, geoPolars, showBoatSpeed } = _buildScenePolars(currentStepId, cfg, state);

  // boatSpeed: include in scale even when drawn separately.
  const boatSpeedDelta = state.deltasById["boatSpeed"];
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
  { id: "overview",   label: "Overview",       scene: "overview" },
  { id: "inputs",     label: "Inputs",         scene: "inputs" },
  { id: "misalign",   label: "Misalignment",   scene: "misalignment" },
  { id: "mastRot",    label: "Mast Rotation",  scene: "mastRotation" },
  { id: "mastHeel",   label: "Mast Heel",      scene: "mastHeel" },
  { id: "mastMove",   label: "Mast Movement",  scene: "mastMovement" },
  { id: "upwash",     label: "Upwash",         scene: "upwash" },
  { id: "leeway",     label: "Leeway",         scene: "leeway" },
  { id: "trueWind",   label: "True Wind",      scene: "trueWind" },
  { id: "height",     label: "Height / 10m",   scene: "height" },
  { id: "backCalc",   label: "Back Calc AW",   scene: "backCalc" },
  { id: "groundWind", label: "Ground Wind",    scene: "groundWind" },
  { id: "outputs",    label: "Outputs",        scene: "outputs" }
];

let currentStepId = "overview";

function setMessage(text) {
  const el = document.getElementById("message");
  if (el) {
    el.textContent = text || "";
  }
}

async function fetchState() {
  try {
    const response = await fetch(`${API_BASE_URL}/state`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      if (response.status === 503) {
        setMessage("Plugin is not running. Enable the plugin.");
      } else if (response.status === 401) {
        setMessage("You are not logged on to the server. Log on to the server.");
      } else {
        setMessage(`Failed to fetch state: ${response.status} ${response.statusText}`);
      }
      return null;
    }

    setMessage("");
    const data = await response.json();
    return data;
  } catch (err) {
    console.error(err);
    setMessage(`Error fetching state: ${err.message}`);
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

function normaliseState(data) {
  const polarsById = {};
  const deltasById = {};
  const attitudesById = {};
  const tablesById = {};

  (data.polars || []).forEach(p => {
    if (p && p.id) polarsById[p.id] = p;
  });
  (data.deltas || []).forEach(d => {
    if (d && d.id) deltasById[d.id] = d;
  });
  (data.attitudes || []).forEach(a => {
    if (a && a.id) attitudesById[a.id] = a;
  });
  (data.tables || []).forEach(t => {
    if (t && t.id) tablesById[t.id] = t;
  });

  state = { polarsById, deltasById, attitudesById, tablesById };
}

// --- Config helpers ---

// Config is a flat object; key is a plain option name such as "correctForMisalign".
function getConfigValue(key) {
  if (!config || !key) return undefined;
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined;
}

// --- Parameter metadata ---
// Provides label, unit and HTML input constraints for every flat config key.
const paramMeta = {
  sensorMisalignment:        { label: "Sensor misalignment",                    unit: "°",  type: "number",  step: 0.1 },
  heightAboveWater:          { label: "Sensor height above water",               unit: "m",  type: "number",  step: 0.5, min: 0 },
  windExponent:              { label: "Wind gradient exponent (α)",              unit: "",   type: "number",  step: 0.01, min: 0.05, max: 0.5, default: 0.14 },
  upwashSlope:               { label: "Upwash slope (α)",                        unit: "",   type: "number",  step: 0.01, min: 0, max: 0.3, default: 0.05 },
  upwashOffset:              { label: "Upwash offset (β)",                       unit: "°",  type: "number",  step: 0.1,  min: -1, max: 4, default: 1.5 },
  timeConstant:              { label: "Smoothing time constant",                 unit: "s",  type: "number",  step: 0.5,  min: 0, max: 10 },
  headingSource:             { label: "Heading source",        path: "navigation.headingTrue",              unit: "",   type: "string", sourceOf: { type: "delta",    id: "heading" } },
  attitudeSource:            { label: "Attitude source",       path: "navigation.attitude",                 unit: "",   type: "string", sourceOf: { type: "attitude", id: "attitude" } },
  boatSpeedSource:           { label: "Boat speed source",     path: "navigation.speedThroughWater",        unit: "",   type: "string", sourceOf: { type: "delta", id: "boatSpeed" } },
  leewaySource:              { label: "Leeway angle source",   path: "navigation.leewayAngle",              unit: "",   type: "string", sourceOf: { type: "delta", id: "leeway" } },
  windSpeedSource:           { label: "Wind speed source",     path: "environment.wind.speedApparent",      unit: "",   type: "string", sourceOf: { type: "polar",    id: "apparentWind" } },
  rotationPath:              { label: "Mast rotation path",                                                 unit: "",   type: "string" },
  rotationSource:            { label: "Mast rotation source",  path: "(see rotation path above)",          unit: "",   type: "string", sourceOf: { type: "delta",    id: "mast" } },
  groundSpeedSource:         { label: "Ground speed source",   path: "navigation.speedOverGround",          unit: "",   type: "string", sourceOf: { type: "polar",    id: "groundSpeed" } },
  calculateGroundWind:       { label: "Calculate ground wind",                   unit: "",   type: "boolean" },
  backCalculateApparentWind: { label: "Back-calculate apparent wind",            unit: "",   type: "boolean" },
  preventDuplication:        { label: "Replace apparent wind (prevent duplication)", unit: "", type: "boolean" }
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
        { type: "polar", id: "apparentWind" },
        { type: "delta", id: "boatSpeed" }
      ];
      if (cfg.correctForMastHeel || cfg.correctForMastMovement)
        items.push({ type: "attitude", id: "attitude" });
      if (cfg.calculateGroundWind) {
        items.push({ type: "delta",  id: "heading" });
        items.push({ type: "polar", id: "groundSpeed" });
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
    description: "Start of the calculation pipeline. The observed apparent wind enters here. Configure the Signal K source to use for wind measurements.",
    correctionFlag: null,
    parameters: ["windSpeedSource"],
    inputs:  [
      { type: "polar", id: "apparentWind" }
    ],
    outputs: []
  },
  misalign: {
    description: "Subtracts a fixed offset from the apparent wind angle to correct for a misaligned wind sensor.",
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
    description: "Corrects the wind angle for vessels with a rotating mast by subtracting the mast rotation angle.",
    correctionFlag: "correctForMastRotation",
    parameters: ["rotationPath", "rotationSource"],
    inputs:  [
      { type: "polar", id: "mastRotIn" },
      { type: "delta", id: "mast" }
    ],
    outputs: [
      { type: "polar", id: "mastRotOut" }
    ]
  },
  mastHeel: {
    description: "Compensates for wind speed underreading caused by the sensor tilting with the heeled mast.",
    correctionFlag: "correctForMastHeel",
    parameters: ["attitudeSource"],
    inputs:  [
      { type: "polar",    id: "mastHeelIn" },
      { type: "attitude", id: "attitude" }
    ],
    outputs: [
      { type: "polar", id: "mastHeelOut" }
    ]
  },
  mastMove: {
    description: "Subtracts mast-tip velocity (from rolling/pitching) from apparent wind to remove wave-induced motion errors.",
    correctionFlag: "correctForMastMovement",
    parameters: ["heightAboveWater", "attitudeSource"],
    inputs:  [
      { type: "polar",    id: "mastMoveIn" },
      { type: "attitude", id: "attitude" },
      { type: "polar",    id: "sensorSpeed" }
    ],
    outputs: [
      { type: "polar", id: "mastMoveOut" }
    ]
  },
  upwash: {
    description: "Rotates apparent wind angle to compensate for sail-induced upwash using a parametric formula.",
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
    description: "Rotates the wind angle by the leeway angle to account for sideways hull drift through the water.",
    correctionFlag: "correctForLeeway",
    parameters: ["leewaySource"],
    inputs:  [
      { type: "polar", id: "leewayIn" },
      { type: "delta", id: "leeway" }
    ],
    outputs: [
      { type: "polar", id: "leewayOut" }
    ]
  },
  trueWind: {
    description: "Calculates true wind by subtracting boat speed from corrected apparent wind. This step is always active.",
    correctionFlag: null,
    parameters: ["boatSpeedSource"],
    inputs:  [
      { type: "polar", id: "trueWindIn" },
      { type: "delta", id: "boatSpeed" }
    ],
    outputs: [
      { type: "polar", id: "trueWind" }
    ]
  },
  height: {
    description: "Scales true wind speed to a reference height of 10 m using the wind gradient power law.",
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
    description: "Back-calculates corrected apparent wind by adding boat speed back to corrected true wind. Enable this to output a corrected apparent wind to Signal K. 'Replace apparent wind' suppresses the original apparent wind delta to avoid duplication.",
    correctionFlag: "backCalculateApparentWind",
    parameters: [
      "preventDuplication"
    ],
    inputs:  [
      { type: "polar", id: "heightOut" }
    ],
    outputs: [
      { type: "polar", id: "backCalcOut" }
    ]
  },
  groundWind: {
    description: "Calculates wind over ground by rotating corrected vessel wind by heading and subtracting speed over ground.",
    correctionFlag: "calculateGroundWind",
    parameters: ["groundSpeedSource", "headingSource"],
    inputs:  [
      { type: "polar", id: "groundWindIn" },
      { type: "polar", id: "groundSpeed" },
      { type: "delta", id: "heading" }
    ],
    outputs: [
      { type: "polar", id: "groundWind" }
    ]
  },
  outputs: {
    description: "End of the pipeline. Configure which values are written to Signal K.",
    correctionFlag: null,
    parameters: [],
    inputs: (cfg) => {
      const items = [ { type: "polar", id: "trueWind" } ];
      if (cfg.backCalculateApparentWind)
        items.push({ type: "polar", id: "backCalcOut" });
      if (cfg.calculateGroundWind)
        items.push({ type: "polar", id: "groundWind" });
      return items;
    },
    outputs: []
  }
};

// --- Panel rendering helpers ---

function sceneSectionHeading(text) {
  const h = document.createElement("h3");
  h.className = "scene-section-heading";
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

// Format a live state object as a short readable string.
function formatStateValue(type, data) {
  if (!data) return "—";
  switch (type) {
    case "polar": {
      const spd = typeof data.magnitude === "number"
        ? (data.magnitude * 1.943844).toFixed(1) + " kn" : "—";
      const ang = typeof data.angle === "number"
        ? (data.angle * 180 / Math.PI).toFixed(1) + "°" : "—";
      return `${spd} / ${ang}`;
    }
    case "delta": {
      if (typeof data.value !== "number") return "—";
      const unit = data.displayAttributes && data.displayAttributes.unit;
      if (unit === "m/s") return (data.value * 1.943844).toFixed(1) + " kn";
      // default: angle in radians → degrees
      return (data.value * 180 / Math.PI).toFixed(1) + "°";
    }
    case "attitude": {
      if (!data.value) return "—";
      const r = (data.value.roll  * 180 / Math.PI).toFixed(1);
      const p = (data.value.pitch * 180 / Math.PI).toFixed(1);
      return `roll ${r}° / pitch ${p}°`;
    }
    default: return "—";
  }
}

// Build a 2-column table (Name | Value) for an array of typed descriptors.
// Supports type "computed" for client-side calculated values.
function createDataTable(items) {
  const table = document.createElement("table");
  table.className = "scene-table";
  items.forEach(item => {
    // --- Computed (client-side calculated) rows ---
    if (item.type === "computed") {
      const row = table.insertRow();
      row.insertCell().textContent = item.label || item.id;
      row.insertCell().textContent = _computeValue(item.id);
      return;
    }
    const data = getStateItem(item);
    const row  = table.insertRow();
    if (isStale(data)) row.className = "stale";
    const nameCell = row.insertCell();
    nameCell.textContent = data
      ? (data.displayAttributes && data.displayAttributes.label) || item.id
      : item.id;
    const valCell = row.insertCell();
    valCell.textContent = data ? formatStateValue(item.type, data) : "—";
  });
  return table;
}

// Build the interactive control for a single config parameter.
function createParamControl(key, meta, value) {
  const container = document.createElement("span");
  if (meta.type === "boolean") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.onchange = () => updateConfigAtPath(key, cb.checked);
    container.appendChild(cb);
  } else if (meta.type === "number") {
    const inp = document.createElement("input");
    inp.type  = "number";
    inp.value = value !== undefined ? value : "";
    if (meta.step !== undefined) inp.step = meta.step;
    if (meta.min  !== undefined) inp.min  = meta.min;
    if (meta.max  !== undefined) inp.max  = meta.max;
    inp.className = "scene-number-input";
    inp.onchange = () => updateConfigAtPath(key, parseFloat(inp.value));
    container.appendChild(inp);
  } else if (meta.sourceOf) {
    // Source selector: build a <select> from the sources array on the state item.
    const sel = document.createElement("select");
    sel.className = "scene-text-input";
    // Always offer an empty option meaning "any source / no filter".
    const blankOpt = document.createElement("option");
    blankOpt.value = "";
    blankOpt.textContent = "(any)";
    sel.appendChild(blankOpt);
    // Populate from the state item's sources array.
    // Polars expose magnitudeSources / angleSources; deltas/attitudes use sources.
    // meta.sourceField selects which polar field to read (default: magnitudeSources).
    const stateItem = getStateItem(meta.sourceOf);
    const sourceField = meta.sourceField || "magnitudeSources";
    const sources = stateItem
      ? (Array.isArray(stateItem[sourceField]) ? stateItem[sourceField]
        : Array.isArray(stateItem.sources)      ? stateItem.sources
        : [])
      : [];
    sources.forEach(src => {
      const opt = document.createElement("option");
      opt.value = src;
      opt.textContent = src;
      sel.appendChild(opt);
    });
    sel.value = value || "";
    sel.onchange = () => updateConfigAtPath(key, sel.value);
    container.appendChild(sel);
  } else {
    const inp = document.createElement("input");
    inp.type  = "text";
    inp.value = value !== undefined ? value : "";
    inp.className = "scene-text-input";
    inp.onchange = () => updateConfigAtPath(key, inp.value);
    container.appendChild(inp);
  }
  return container;
}

// Return true if a state item is considered stale / unavailable.
function isStale(data) {
  if (!data) return true;
  // Top-level stale flag (set by signalkutilities on handlers)
  if (data.stale === true) return true;
  // displayAttributes.stale is also used
  if (data.displayAttributes && data.displayAttributes.stale === true) return true;
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
      const label = (data.displayAttributes && data.displayAttributes.label) || item.id;
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
    lbl.className = "scene-enable";
    const cb  = document.createElement("input");
    cb.type    = "checkbox";
    cb.checked = !!getConfigValue(cfg.correctionFlag);
    cb.onchange = () => updateConfigAtPath(cfg.correctionFlag, cb.checked);
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(" Enabled"));
    enableEl.appendChild(lbl);
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

  function buildParamTable(params) {
    const table = document.createElement("table");
    table.className = "scene-table";
    params.forEach(entry => {
      const key      = typeof entry === "string" ? entry : entry.key;
      const meta     = paramMeta[key] || { label: key, type: "string", unit: "" };
      const value    = getConfigValue(key);
      const row      = table.insertRow();
      const nameCell = row.insertCell();
      const rowLabel = meta.path || meta.label;
      nameCell.textContent = meta.unit ? `${rowLabel} (${meta.unit})` : rowLabel;
      const valCell  = row.insertCell();
      valCell.appendChild(createParamControl(key, meta, value));
      if (meta.default !== undefined && value !== meta.default) {
        const btn = document.createElement("button");
        btn.className = "param-reset-btn";
        btn.title = `Reset to default (${meta.default})`;
        btn.textContent = "↺";
        btn.onclick = () => updateConfigAtPath(key, meta.default);
        valCell.appendChild(btn);
      }
    });
    return table;
  }

  if (settingParams.length > 0) {
    settingsEl.appendChild(sceneSectionHeading("Settings"));
    settingsEl.appendChild(buildParamTable(settingParams));
  }

  if (sourcesEl && sourceParams.length > 0) {
    sourcesEl.appendChild(sceneSectionHeading("Sources"));
    sourcesEl.appendChild(buildParamTable(sourceParams));
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
      warningsEl.appendChild(sceneSectionHeading("Missing:"));
      const list = document.createElement("ul");
      list.className = "scene-warnings";
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
        const label = (data.displayAttributes && data.displayAttributes.label) || item.id;
        missing.push(`"${label}" — data is stale or missing`);
      }
    });
    if (missing.length > 0) {
      warningsEl.appendChild(sceneSectionHeading("Missing:"));
      const list = document.createElement("ul");
      list.className = "scene-warnings";
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
    const item = document.createElement("div");
    item.className = "nav-item" + (step.id === currentStepId ? " active-step" : "");
    item.textContent = step.label;
    item.onclick = () => {
      currentStepId = step.id;
      renderAll();
    };
    nav.appendChild(item);
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
  const data = await fetchState();
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
  await fetchConfig();
  renderAll();
  await tick();
  setInterval(tick, 100);
}

window.addEventListener("DOMContentLoaded", () => {
  start();
});
