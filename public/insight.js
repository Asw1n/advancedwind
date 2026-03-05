const API_BASE_URL = "/plugins/advancedwind";

let canvas;
let ctx;
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
  windExponent:              { label: "Wind gradient exponent (α)",              unit: "",   type: "number",  step: 0.01, min: 0.05, max: 0.5 },
  upwashSlope:               { label: "Upwash slope (α)",                        unit: "",   type: "number",  step: 0.01, min: 0, max: 0.3 },
  upwashOffset:              { label: "Upwash offset (β)",                       unit: "°",  type: "number",  step: 0.1,  min: -1, max: 4 },
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
    inputs:  [
      { type: "polar", id: "apparentWind" },
      { type: "delta", id: "boatSpeed" },
      { type: "delta", id: "heading" }
    ],
    outputs: [
      { type: "polar", id: "trueWind" },
      { type: "polar", id: "calculatedWind" },
      { type: "polar", id: "groundWind" }
    ]
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
      { type: "attitude", id: "attitude" }
    ],
    outputs: [
      { type: "polar", id: "mastMoveOut" },
      { type: "polar", id: "sensorSpeed" }
    ]
  },
  upwash: {
    description: "Rotates apparent wind angle to compensate for sail-induced upwash using a parametric formula.",
    correctionFlag: "correctForUpwash",
    parameters: ["upwashSlope", "upwashOffset"],
    inputs:  [
      { type: "polar", id: "upwashIn" }
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
    parameters: [
      "calculateGroundWind"
    ],
    inputs:  [
      { type: "polar", id: "trueWind" },
      { type: "polar", id: "calculatedWind" },
      { type: "polar", id: "groundWind" }
    ],
    outputs: []
  }
};

function setupCanvas() {
  canvas = document.getElementById("insight-canvas");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
}

function resizeCanvas() {
  if (!canvas) return;
  const parent = canvas.parentElement || document.body;
  const size = Math.min(parent.clientWidth || 300, 500);
  canvas.width = size;
  canvas.height = size;
  render();
}

function clearCanvas() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBoatTop(headingRadians) {
  if (!ctx || !canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.translate(w / 2, h / 2);

  // Boat always drawn pointing up (no heading rotation for now)
  ctx.beginPath();
  ctx.moveTo(0, -40);
  ctx.lineTo(20, 40);
  ctx.lineTo(-20, 40);
  ctx.closePath();
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawVector(originX, originY, angle, magnitude, scale, color, label) {
  if (!ctx) return;
  const len = magnitude * scale;
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;

  ctx.save();
  ctx.translate(originX, originY);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(dx, dy);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Arrow head
  const headLen = 8;
  const headAngle1 = angle + Math.PI * 0.85;
  const headAngle2 = angle - Math.PI * 0.85;
  ctx.beginPath();
  ctx.moveTo(dx, dy);
  ctx.lineTo(dx + Math.cos(headAngle1) * headLen, dy + Math.sin(headAngle1) * headLen);
  ctx.moveTo(dx, dy);
  ctx.lineTo(dx + Math.cos(headAngle2) * headLen, dy + Math.sin(headAngle2) * headLen);
  ctx.stroke();

  if (label) {
    ctx.fillStyle = color;
    ctx.font = "12px sans-serif";
    ctx.fillText(label, dx + 5, dy + 5);
  }

  ctx.restore();
}

function renderOverview() {
  if (!ctx || !canvas) return;
  clearCanvas();

  const w = canvas.width;
  const h = canvas.height;
  const originX = w / 2;
  const originY = h / 2;

  const polars = state.polarsById;
  const idsOfInterest = [
    "apparentWind",
    "calculatedWind",
    "boatSpeed",
    "trueWind",
    "groundSpeed",
    "groundWind"
  ];

  let maxMag = 0.1;
  idsOfInterest.forEach(id => {
    const p = polars[id];
    if (p && typeof p.magnitude === "number") {
      maxMag = Math.max(maxMag, Math.abs(p.magnitude));
    }
  });

  const scale = (Math.min(w, h) * 0.35) / maxMag;

  // Draw boat
  const headingDelta = state.deltasById["heading"];
  const heading = headingDelta ? headingDelta.value : 0;
  drawBoatTop(heading);

  const colors = {
    apparentWind: "#0288d1",
    calculatedWind: "#26c6da",
    boatSpeed: "#388e3c",
    trueWind: "#00bcd4",
    groundSpeed: "#5d4037",
    groundWind: "#1976d2"
  };

  idsOfInterest.forEach(id => {
    const p = polars[id];
    if (!p) return;
    // Boat-plane vs ground-plane: for now, draw all in their own frame using p.angle
    drawVector(originX, originY, p.angle, p.magnitude, scale, colors[id] || "#000", p.displayAttributes && p.displayAttributes.label);
  });

  // Update live inputs section with simple numeric values
  const inputsEl = document.getElementById("panel-inputs");
  if (inputsEl) {
    inputsEl.innerHTML = "";
    const list = document.createElement("ul");
    idsOfInterest.forEach(id => {
      const p = polars[id];
      if (!p) return;
      const li = document.createElement("li");
      const label = p.displayAttributes && p.displayAttributes.label ? p.displayAttributes.label : id;
      const mag = typeof p.magnitude === "number" && p.magnitude !== null ? p.magnitude.toFixed(2) : "—";
      const ang = typeof p.angle === "number" && p.angle !== null ? p.angle.toFixed(2) : "—";
      li.textContent = `${label}: speed=${mag} angle(rad)=${ang}`;
      list.appendChild(li);
    });
    inputsEl.appendChild(list);
  }
}

function renderCanvasScene(sceneId) {
  switch (sceneId) {
    case "overview":
      return renderOverview();
    // Other scenes will be implemented later; for now, fall back to overview.
    case "inputs":
    case "misalignment":
    case "mastRotation":
    case "mastHeel":
    case "mastMovement":
    case "upwash":
    case "leeway":
    case "trueWind":
    case "height":
    case "backCalc":
    case "groundWind":
    case "outputs":
    default:
      return renderOverview();
  }
}

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
function createDataTable(items) {
  const table = document.createElement("table");
  table.className = "scene-table";
  items.forEach(item => {
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

  // 4. Settings
  settingsEl.innerHTML = "";
  const activeParams = (cfg.parameters || []).filter(entry => {
    if (typeof entry === "string") return true;
    return entry.showIf ? entry.showIf(config || {}) : true;
  });
  if (activeParams.length > 0) {
    settingsEl.appendChild(sceneSectionHeading("Settings"));
    const table = document.createElement("table");
    table.className = "scene-table";
    activeParams.forEach(entry => {
      const key   = typeof entry === "string" ? entry : entry.key;
      const meta  = paramMeta[key] || { label: key, type: "string", unit: "" };
      const value = getConfigValue(key);
      const row   = table.insertRow();
      const nameCell = row.insertCell();
      const rowLabel = meta.path || meta.label;
      nameCell.textContent = meta.unit ? `${rowLabel} (${meta.unit})` : rowLabel;
      const valCell = row.insertCell();
      valCell.appendChild(createParamControl(key, meta, value));
    });
    settingsEl.appendChild(table);
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

  // 5. Inputs
  inputsEl.innerHTML = "";
  if (cfg && cfg.inputs && cfg.inputs.length > 0) {
    inputsEl.appendChild(sceneSectionHeading("Inputs"));
    inputsEl.appendChild(createDataTable(cfg.inputs));
  }

  // 6. Outputs
  outputsEl.innerHTML = "";
  if (cfg && cfg.outputs && cfg.outputs.length > 0) {
    outputsEl.appendChild(sceneSectionHeading("Outputs"));
    outputsEl.appendChild(createDataTable(cfg.outputs));
  }

  // 7. Warnings
  warningsEl.innerHTML = "";
  if (cfg && cfg.correctionFlag) {
    const reasons = getCannotActivateReasons(cfg);
    if (reasons.length > 0) {
      warningsEl.appendChild(sceneSectionHeading("Cannot be activated because:"));
      const list = document.createElement("ul");
      list.className = "scene-warnings";
      reasons.forEach(r => {
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
// Only updates the canvas and live data sections (inputs/outputs/warnings).
// Never touches interactive controls (checkboxes, number inputs, dropdowns).
function render() {
  const step = steps.find(s => s.id === currentStepId) || steps[0];
  renderCanvasScene(step.scene);
  renderPanelLive(step);
}

// Full render: rebuilds nav, all panel sections, and canvas.
// Call this when the active step changes or after a config change.
function renderAll() {
  const step = steps.find(s => s.id === currentStepId) || steps[0];
  buildNav();
  renderCanvasScene(step.scene);
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
  setupCanvas();
  await fetchConfig();
  // Establish DOM structure in correct order (static sections before live sections)
  // before the first tick, which would otherwise create #panel-live first.
  renderAll();
  await tick();
  setInterval(tick, 1000);
}

window.addEventListener("DOMContentLoaded", () => {
  start();
});
