const { Polar, PolarSmoother, SmoothedAngle, Reporter, ExponentialSmoother, MovingAverageSmoother, KalmanSmoother, PassThroughSmoother, MessageSmoother, createSmoothedPolar, createSmoothedHandler } = require('signalkutilities');
const path = require('path');

module.exports = function (app) {
  const currentVersion = "3.1";

  let options = {};
  let changedOptions = {};
  const defaultOptions = {
    // version
    'version': currentVersion,
    // Corrections
    'correctForMisalign': false,
    'correctForMastRotation': false,
    'correctForMastHeel': false,
    'correctForMastMovement': false,
    'correctForUpwash': false,
    'correctForLeeway': false,
    'correctForHeight': false,

    // Output Options
    'calculateGroundWind': false,
    'backCalculateApparentWind': true,
    'preventDuplication': true,

    // Parameters
    'sensorMisalignment': 0,
    'heightAboveWater': 15,
    'windExponent': 0.14,
    'upwashSlope': 0.05,
    'upwashOffset': 1.5,

    // Smoother
    'smootherClass': 'ExponentialSmoother',
    'smootherTau': 0.45,
    'smootherTimeSpan': 2,
    'smootherSteadyState': 0.2,

    // Attitude smoother (separate — attitude is differentiated to compute sensor speed)
    'attitudeSmootherClass': 'MovingAverageSmoother',
    'attitudeSmootherTau': 1,
    'attitudeSmootherTimeSpan': 1,
    'attitudeSmootherSteadyState': 0.2,

    // Data Sources
    'headingSource': '',
    'attitudeSource': '',
    'boatSpeedSource': '',
    'leewaySource': '',
    'windSpeedSource': '',
    'rotationSource': '',
    'groundSpeedSource': '',

    // Wind Shift Detection
    'detectWindShift': false,
    'windShiftFastClass': 'ExponentialSmoother',
    'windShiftFastTau': 30,
    'windShiftFastTimeSpan': 30,
    'windShiftFastSteadyState': 0.1,
    'windShiftSlowClass': 'ExponentialSmoother',
    'windShiftSlowTau': 300,
    'windShiftSlowTimeSpan': 300,
    'windShiftSlowSteadyState': 0.02
  };
  let isRunning = false;

  function readOptions() {
    const stored = app.readPluginOptions();
    // Unwrap double-nested configuration if present (migration)
    let temp = stored.configuration || {};
    if (temp.configuration) {
      app.debug("Migrating double-nested configuration");
      options = { ...temp.configuration };
      saveOptions();
      return;
    }
    if (Object.keys(temp).length === 0) {
      options = { ...defaultOptions };
      app.debug("No existing options found, using defaults:", options);
      saveOptions();
      return;
    }
    if (!temp.version) {
      app.debug(`Converting options to version ${currentVersion}`);
      options = { ...options, ...temp };
      options = { ...options, ...temp.dataSources };
      options = { ...options, ...temp.corrections };
      options = { ...options, ...temp.outputOptions };
      options = { ...options, ...temp.parameters };
      options.version = currentVersion;
      saveOptions();
      return;
    }
    else if (temp.version === "3.0") {
      options = { ...defaultOptions, ...temp };
      options.version = currentVersion;
      saveOptions();
      return;
    }
    else if (temp.version === currentVersion) {
      options = { ...defaultOptions, ...temp };
      return;
    }
  }

  function saveOptions() {
    app.savePluginOptions({ ...options }, (err) => {
      if (err) {
        app.error(`Error saving plugin options: ${err.message}`);
      }
    });
  }

  const plugin = {};
  plugin.id = "AdvancedWind";
  plugin.name = "Advanced Wind";
  plugin.description = "A plugin that calculates true wind while optionally correcting for vessel motion, upwash, leeway and mast height.";
  // Plugin is configured via the custom webapp (insight.html), not the Signal K admin UI.
  plugin.schema   = {
    type: "object",
    description: "Advanced Wind is configured through its own webapp. Open it from the Signal K app list (Webapps → Advanced Wind) to set sources, enable corrections and adjust parameters.",
    properties: {}
  };
  plugin.uiSchema = {};

  let reportFull = null;
  let heading = null;
  let mast = null;
  let attitude = null;
  let sensorSpeed = null;
  let boatSpeed = null;        // Polar (angle always 0, magnitude=STW) — used in pipeline vector math
  let boatSpeedHandler = null; // delta handler for navigation.speedThroughWater
  let leewayHandler = null;    // delta handler for navigation.leewayAngle
  let groundSpeed = null;
  let groundWind = null;
  let calculatedWind = null;
  let trueWind = null;
  let apparentWind = null;
  // Snapshot polars – one pair per correction step capturing calculatedWind
  // before and after each step so the webapp can display per-step before/after.
  // Steps that do not modify calculatedWind only have an *In polar.
  let misalignIn  = null; let misalignOut  = null;
  let mastRotIn   = null; let mastRotOut   = null;
  let mastHeelIn  = null; let mastHeelOut  = null;
  let mastMoveIn  = null; let mastMoveOut  = null;
  let upwashIn    = null; let upwashOut    = null;
  let leewayIn    = null; let leewayOut    = null;
  let trueWindIn  = null;                          // trueWind step: no calculatedWind output
  let heightIn    = null; let heightOut    = null; // heightIn = trueWind before scale
  let backCalcOut = null;                          // back-calculated apparent wind snapshot
  let groundWindIn = null;                         // groundWind step: no calculatedWind output
  let upwashAngle  = null;                         // computed upwash angle (rad) — scalar delta
  let windShiftFast = null;  // SmoothedAngle on environment.wind.directionTrue (fast EMA)
  let windShiftSlow = null;  // SmoothedAngle on environment.wind.directionTrue (slow EMA / reference)
  let windShift     = null;  // inline delta: angle diff (rad) between fast and slow means


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');
    // Load options here — app is fully initialized by the time Signal K calls
    // registerWithRouter, so app.readPluginOptions() is available. This ensures
    // the /config GET endpoint serves real data before plugin.start() is called.
    readOptions();


    // Static metadata — serve once at webapp load
    router.get('/meta', (req, res) => {
      if (!isRunning || !reportFull) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        try {
          res.json(reportFull.meta());
        } catch (err) {
          app.error(`AdvancedWind /meta error: ${err.message}`);
          res.status(500).json({ error: "Failed to build meta" });
        }
      }
    });

    // Dynamic staleness — cheap poll (e.g. every 2 s)
    router.get('/state', (req, res) => {
      if (!isRunning || !reportFull) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        try {
          res.json(reportFull.state());
        } catch (err) {
          app.error(`AdvancedWind /state error: ${err.message}`);
          res.status(500).json({ error: "Failed to build state" });
        }
      }
    });

    // Full live report — frequent poll / SSE
    router.get('/report', (req, res) => {
      if (!isRunning || !reportFull) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        try {
          res.json(reportFull.report());
        } catch (err) {
          app.error(`AdvancedWind /report error: ${err.message}`);
          res.status(500).json({ error: "Failed to build report" });
        }
      }
    });

    // Endpoints for reading and updating plugin options.
    // Named /settings (not /config) to avoid shadowing Signal K's built-in
    // /plugins/{id}/config endpoint which returns the raw options envelope.
    router.get('/settings', (req, res) => {
      // Merge pending changedOptions so the client always sees the latest intended state,
      // even if calculate() hasn't run yet to drain changedOptions into options.
      res.json({ ...options, ...changedOptions });
    });

    router.put('/settings', (req, res) => {
      changedOptions = { ...changedOptions, ...req.body || {} };
      // Return the full merged config so the client can update itself in one round-trip.
      res.json({ ...options, ...changedOptions });
    });

    // Placeholder endpoint for discovering available sources per Signal K path.
    // In a later phase this should query the Signal K server's data model.
    router.get('/sources', (req, res) => {
      const pathParam = req.query && req.query.path;
      if (!pathParam) {
        return res.status(400).json({ error: "Missing 'path' query parameter" });
      }

      // TODO: Implement real source discovery using the Signal K server API.
      // For now we return an empty list so the front-end API shape is stable.
      res.json({ path: pathParam, sources: [] });
    });

  }

  function resolveSmootherClass(name) {
    switch (name) {
      case 'ExponentialSmoother':   return ExponentialSmoother;
      case 'MovingAverageSmoother': return MovingAverageSmoother;
      case 'PassThroughSmoother':   return PassThroughSmoother;
      case 'KalmanSmoother':
      default:                      return KalmanSmoother;
    }
  }

  function buildSmootherOptions(opts) {
    switch (opts.smootherClass || 'KalmanSmoother') {
      case 'ExponentialSmoother': {
        const tau = Math.max(0.05, opts.smootherTau ?? 1);
        return { tau };
      }
      case 'MovingAverageSmoother': {
        const timeSpan = Math.max(0.05, opts.smootherTimeSpan ?? 1);
        return { timeSpan };
      }
      case 'PassThroughSmoother':
        return {};
      case 'KalmanSmoother':
      default: {
        const raw = opts.smootherSteadyState ?? 0.3;
        const steadyState = Math.min(0.99, Math.max(0.01, raw));
        return { steadyState };
      }
    }
  }

  function buildAttitudeSmootherOptions(opts) {
    const cls = opts.attitudeSmootherClass || 'MovingAverageSmoother';
    switch (cls) {
      case 'ExponentialSmoother': {
        const tau = Math.max(0.05, opts.attitudeSmootherTau ?? 1);
        return { tau };
      }
      case 'PassThroughSmoother':
        return {};
      case 'KalmanSmoother': {
        const raw = opts.attitudeSmootherSteadyState ?? 0.2;
        const steadyState = Math.min(0.99, Math.max(0.01, raw));
        return { steadyState };
      }
      case 'MovingAverageSmoother':
      default: {
        const timeSpan = Math.max(0.05, opts.attitudeSmootherTimeSpan ?? 1);
        return { timeSpan };
      }
    }
  }

  function buildWindShiftFastOptions(opts) {
    switch (opts.windShiftFastClass || 'ExponentialSmoother') {
      case 'ExponentialSmoother': {
        const tau = Math.max(1, opts.windShiftFastTau ?? 30);
        return { tau };
      }
      case 'MovingAverageSmoother': {
        const timeSpan = Math.max(1, opts.windShiftFastTimeSpan ?? 30);
        return { timeSpan };
      }
      case 'PassThroughSmoother':
        return {};
      case 'KalmanSmoother':
      default: {
        const raw = opts.windShiftFastSteadyState ?? 0.1;
        const steadyState = Math.min(0.99, Math.max(0.01, raw));
        return { steadyState };
      }
    }
  }

  function buildWindShiftSlowOptions(opts) {
    switch (opts.windShiftSlowClass || 'ExponentialSmoother') {
      case 'ExponentialSmoother': {
        const tau = Math.max(1, opts.windShiftSlowTau ?? 300);
        return { tau };
      }
      case 'MovingAverageSmoother': {
        const timeSpan = Math.max(1, opts.windShiftSlowTimeSpan ?? 300);
        return { timeSpan };
      }
      case 'PassThroughSmoother':
        return {};
      case 'KalmanSmoother':
      default: {
        const raw = opts.windShiftSlowSteadyState ?? 0.02;
        const steadyState = Math.min(0.99, Math.max(0.01, raw));
        return { steadyState };
      }
    }
  }

  plugin.start = () => {
    app.debug("plugin started");
    app.setPluginStatus("Starting");
    // Store options at module scope so runtime changes via /config
    // can be picked up by the calculation logic. Guard against
    // non-object values coming from a corrupted configuration file.
    readOptions();
    const outputs = [];
    reportFull = new Reporter();
    let SmootherClass = resolveSmootherClass(options.smootherClass);
    let smootherOptions = buildSmootherOptions(options);

    // heading
    heading = createSmoothedHandler({
      id: "heading",
      path: "navigation.headingTrue",
      source: options.headingSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
    });

    //mast rotation (always create handler; options decide whether it is used)
    mast = createSmoothedHandler({
      id: "mast",
      path: options.rotationPath,
      source: options.rotationSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
    });

    //attitude (always create handler; corrections decide whether it is used)
    attitude = createSmoothedHandler({
      id: "attitude",
      path: "navigation.attitude",
      source: options.attitudeSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: resolveSmootherClass(options.attitudeSmootherClass),
      smootherOptions: buildAttitudeSmootherOptions(options),
    });
    sensorSpeed = new Polar(app, plugin.id, "sensorSpeed");
    sensorSpeed.setMeta({ displayName: "Speed of sensor", plane: "Boat" });

    // Compute sensorSpeed exactly once per attitude sample, using the correct deltaT
    // between consecutive attitude updates. This avoids the problem of calculate()
    // firing on every wind delta (often with the same attitude value), which would
    // recompute a near-zero rotation rate and destroy the valid sensorSpeed.
    //
    // attLastTime/attPrevious are declared at plugin.start() scope so applyOptionChanges()
    // can also reset them when the attitude smoother is reconfigured.
    let attLastTime = null;
    let attPrevious = null;
    // Minimum interval between derivative computations (ms).
    // Attitude messages can arrive in bursts only milliseconds apart; dividing
    // a small angle change by a near-zero deltaT produces huge spurious velocities.
    // By requiring at least MIN_ATT_INTERVAL ms we accumulate a reliable window:
    // attPrevious only advances when we actually compute, so the full angular
    // change since the last accepted sample is always used.
    const MIN_ATT_INTERVAL = 50;
    // Keys that trigger an attitude smoother reset.
    const ATTITUDE_SMOOTHER_KEYS = ['attitudeSmootherClass', 'attitudeSmootherTau', 'attitudeSmootherTimeSpan', 'attitudeSmootherSteadyState'];
    attitude.onChange = () => {
      // Apply attitude smoother settings eagerly — don't wait for calculate() (wind data).
      // Also resets derivative state to avoid a spike from the smoother discontinuity.
      if (ATTITUDE_SMOOTHER_KEYS.some(k => k in changedOptions)) {
        for (const k of ATTITUDE_SMOOTHER_KEYS) {
          if (k in changedOptions) { options[k] = changedOptions[k]; delete changedOptions[k]; }
        }
        attitude.setSmootherOptions(buildAttitudeSmootherOptions(options));
        attitude.setSmootherClass(resolveSmootherClass(options.attitudeSmootherClass));
        saveOptions();
        attLastTime = null;
        attPrevious = null;
        return;  // skip derivative computation this cycle
      }
      const current = attitude.value;
      if (!current) return;
      const now = Date.now();
      if (!attLastTime) {
        attLastTime = now;
        attPrevious = { ...current };
        return;
      }
      const deltaT = (now - attLastTime) / 1000;
      // Skip samples that arrive too close together — wait for the window to grow.
      if (deltaT < MIN_ATT_INTERVAL / 1000) return;
      attLastTime = now;
      const r = options.heightAboveWater;
      sensorSpeed.setVectorValue({
        x: ((current.pitch - attPrevious.pitch) / deltaT) * r,
        y: ((current.roll  - attPrevious.roll)  / deltaT) * r
      });
      attPrevious = { ...current };
    };

    // Snapshot polars for per-step before/after inspection
    misalignIn  = new Polar(app, plugin.id, "misalignIn");  misalignIn.setMeta({  displayName: "Before misalignment",      plane: "Boat" });
    misalignOut = new Polar(app, plugin.id, "misalignOut"); misalignOut.setMeta({ displayName: "After misalignment",       plane: "Boat" });
    mastRotIn   = new Polar(app, plugin.id, "mastRotIn");   mastRotIn.setMeta({   displayName: "Before mast rotation",     plane: "Boat" });
    mastRotOut  = new Polar(app, plugin.id, "mastRotOut");  mastRotOut.setMeta({  displayName: "After mast rotation",      plane: "Boat" });
    mastHeelIn  = new Polar(app, plugin.id, "mastHeelIn");  mastHeelIn.setMeta({  displayName: "Before mast heel",         plane: "Boat" });
    mastHeelOut = new Polar(app, plugin.id, "mastHeelOut"); mastHeelOut.setMeta({ displayName: "After mast heel",          plane: "Boat" });
    mastMoveIn  = new Polar(app, plugin.id, "mastMoveIn");  mastMoveIn.setMeta({  displayName: "Before mast movement",     plane: "Boat" });
    mastMoveOut = new Polar(app, plugin.id, "mastMoveOut"); mastMoveOut.setMeta({ displayName: "After mast movement",      plane: "Boat" });
    upwashIn    = new Polar(app, plugin.id, "upwashIn");    upwashIn.setMeta({    displayName: "Before upwash",            plane: "Boat" });
    upwashOut   = new Polar(app, plugin.id, "upwashOut");   upwashOut.setMeta({   displayName: "After upwash",             plane: "Boat" });
    leewayIn    = new Polar(app, plugin.id, "leewayIn");    leewayIn.setMeta({    displayName: "Before leeway",            plane: "Boat" });
    leewayOut   = new Polar(app, plugin.id, "leewayOut");   leewayOut.setMeta({   displayName: "After leeway",             plane: "Boat" });
    trueWindIn  = new Polar(app, plugin.id, "trueWindIn");  trueWindIn.setMeta({  displayName: "Corrected apparent wind",  plane: "Boat" });
    heightIn    = new Polar(app, plugin.id, "heightIn");    heightIn.setMeta({    displayName: "True wind (before height norm.)", plane: "Boat" });
    heightOut   = new Polar(app, plugin.id, "heightOut");   heightOut.setMeta({   displayName: "True wind (after height norm.)",  plane: "Boat" });
    backCalcOut = new Polar(app, plugin.id, "backCalcOut"); backCalcOut.setMeta({ displayName: "Corrected apparent wind",  plane: "Boat" });
    groundWindIn = new Polar(app, plugin.id, "groundWindIn"); groundWindIn.setMeta({ displayName: "Corrected apparent wind", plane: "Boat" });

    // Configure SK paths for intermediate polars so the webapp can read unit
    // metadata (units, displayUnits) from SK for correct value formatting.
    // These polars are never subscribed — paths are metadata-only references.
    for (const p of [misalignIn, misalignOut, mastRotIn, mastRotOut, mastHeelIn, mastHeelOut,
                     mastMoveIn, mastMoveOut, upwashIn, upwashOut, leewayIn, leewayOut,
                     trueWindIn, backCalcOut, groundWindIn]) {
      p.configureMagnitude("environment.wind.speedApparent", "", false);
      p.configureAngle("environment.wind.angleApparent", "", false);
    }
    for (const p of [heightIn, heightOut]) {
      p.configureMagnitude("environment.wind.speedTrue", "", false);
      p.configureAngle("environment.wind.angleTrueWater", "", false);
    }

    // Scalar delta for the computed upwash correction angle (radians).
    // Always computed each cycle (even when correction is disabled) so the
    // UI can display the would-be correction regardless of the toggle state.
    upwashAngle = {
      id: "upwashAngle",
      value: null,
      stale: true,
      meta: { displayName: "Calculated upwash", units: "rad" },
      get state() { return { stale: this.stale, frequency: null, sources: [] }; },
      report() {
        return { id: this.id, value: this.value, state: this.state };
      }
    };

    //apparent wind
    apparentWind = createSmoothedPolar({
      id: "apparentWind",
      pathMagnitude: "environment.wind.speedApparent",
      pathAngle: "environment.wind.angleApparent",
      subscribe: true,
      sourceMagnitude: options.windSpeedSource,
      sourceAngle: options.windSpeedSource,
      app: app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
      meta: { displayName: "Apparent Wind", plane: "Boat" },
      passOn: !options.preventDuplication,
    });


    // Boat speed and leeway: two independent delta handlers.
    // boatSpeed polar is angle=0 (forward-only) so leeway is NOT implicitly included
    // in true wind subtraction — it is only applied explicitly in the leeway correction step.
    boatSpeedHandler = createSmoothedHandler({
      id: "boatSpeed",
      path: "navigation.speedThroughWater",
      source: options.boatSpeedSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
    });

    leewayHandler = createSmoothedHandler({
      id: "leeway",
      path: "navigation.leewayAngle",
      source: options.leewaySource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
    });

    // Forward-only polar: angle is always 0. Updated each cycle from boatSpeedHandler.
    boatSpeed = new Polar(app, plugin.id, "boatSpeed");
    boatSpeed.setMeta({ displayName: "Boat Speed", plane: "Boat" });

    // ground wind and ground speed (always created; options decide whether used/output)
    groundWind = new Polar(app, plugin.id, "groundWind");
    groundWind.configureMagnitude("environment.wind.speedOverGround");
    groundWind.configureAngle("environment.wind.directionTrue");
    groundWind.setAngleRange('0to2pi');
    groundWind.setMeta({ displayName: "Ground Wind", plane: "Ground" });

    groundSpeed = createSmoothedPolar({
      id: "groundSpeed",
      pathMagnitude: "navigation.speedOverGround",
      pathAngle: "navigation.courseOverGroundTrue",
      subscribe: true,
      sourceMagnitude: options.groundSpeedSource,
      sourceAngle: options.groundSpeedSource,
      app,
      pluginId: plugin.id,
      SmootherClass,
      smootherOptions,
      meta: { displayName: "Ground Speed", plane: "Ground" },
      passOn: true,
      angleRange: '0to2pi'
    });

    // calculated wind
    calculatedWind = new Polar(app, plugin.id, "calculatedWind");
    calculatedWind.configureMagnitude("environment.wind.speedApparent");
    calculatedWind.configureAngle("environment.wind.angleApparent");
    calculatedWind.setMeta({ displayName: "Apparent Wind", plane: "Boat" });
    calculatedWind.angleRange = '-piToPi';

    //true wind
    trueWind = new Polar(app, plugin.id, "trueWind");
    trueWind.configureMagnitude("environment.wind.speedTrue");
    trueWind.configureAngle("environment.wind.angleTrueWater");
    trueWind.setMeta({ displayName: "True Wind", plane: "Boat" });
    trueWind.angleRange = '-piToPi';

    // Wind shift detection: two SmoothedAngles subscribing to the plugin's own groundWind output.
    // A fake pluginId prevents the own-source echo guard from blocking the plugin's messages;
    // source: plugin.id ensures only this plugin's groundWind deltas are accepted.
    windShiftFast = new SmoothedAngle(app, 'windShiftFastInternal', 'windShiftFast',
      'environment.wind.directionTrue', {
        source: plugin.id,
        passOn: true,
        angleRange: '0to2pi',
        meta: { displayName: 'Fast mean wind direction', plane: 'Ground' },
        SmootherClass: resolveSmootherClass(options.windShiftFastClass),
        smootherOptions: buildWindShiftFastOptions(options),
      }
    );
    windShiftFast.id = 'windShiftFast';

    windShiftSlow = new SmoothedAngle(app, 'windShiftSlowInternal', 'windShiftSlow',
      'environment.wind.directionTrue', {
        source: plugin.id,
        passOn: true,
        angleRange: '0to2pi',
        meta: { displayName: 'Slow mean wind direction (reference)', plane: 'Ground' },
        SmootherClass: resolveSmootherClass(options.windShiftSlowClass),
        smootherOptions: buildWindShiftSlowOptions(options),
      }
    );
    windShiftSlow.id = 'windShiftSlow';

    windShift = {
      id: 'windShift',
      value: null,
      stale: true,
      meta: { displayName: 'Wind Shift', units: 'rad' },
      get state() { return { stale: this.stale, frequency: null, sources: [] }; },
      report() { return { id: this.id, value: this.value, state: this.state }; }
    };

    // Recalculate windShift whenever windShiftFast gets a new sample.
    windShiftFast.onChange = () => {
      if (!options.detectWindShift) return;
      const fast = windShiftFast.value;
      const slow = windShiftSlow.value;
      if (typeof fast !== 'number' || typeof slow !== 'number') return;
      const raw = fast - slow;
      windShift.value = ((raw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      windShift.stale = false;
    };

    //# endregion initialization of paths

    //# region defining report (always register complete set)
    reportFull.addDelta(heading);
    reportFull.addDelta(mast);
    reportFull.addAttitude(attitude);
    reportFull.addPolar(apparentWind);
    reportFull.addDelta(boatSpeedHandler);
    reportFull.addDelta(leewayHandler);
    reportFull.addPolar(boatSpeed);
    reportFull.addPolar(trueWind);
    reportFull.addPolar(calculatedWind);
    reportFull.addPolar(groundSpeed);
    reportFull.addPolar(groundWind);
    // Snapshot polars
    reportFull.addPolar(misalignIn);  reportFull.addPolar(misalignOut);
    reportFull.addPolar(mastRotIn);   reportFull.addPolar(mastRotOut);
    reportFull.addPolar(mastHeelIn);  reportFull.addPolar(mastHeelOut);
    reportFull.addPolar(mastMoveIn);  reportFull.addPolar(mastMoveOut);
    reportFull.addPolar(sensorSpeed);
    reportFull.addPolar(upwashIn);    reportFull.addPolar(upwashOut);  reportFull.addDelta(upwashAngle);
    reportFull.addPolar(leewayIn);    reportFull.addPolar(leewayOut);
    reportFull.addPolar(trueWindIn);
    reportFull.addPolar(heightIn);    reportFull.addPolar(heightOut);
    reportFull.addPolar(backCalcOut);
    reportFull.addPolar(groundWindIn);
    // Wind shift
    reportFull.addDelta(windShiftFast);
    reportFull.addDelta(windShiftSlow);
    reportFull.addDelta(windShift);
    //#endregion defining report

    apparentWind.onChange = () => {
      calculate();
    };

    isRunning = true;
    app.debug("Start wind calculations");
    app.setPluginStatus("Running");



    function calculate() {
      // Re-read options at runtime so /config changes take effect
      if (Object.keys(changedOptions).length) applyOptionChanges();

      calculatedWind.copyFrom(apparentWind);

      // Rebuild forward-only boat speed polar (angle=0) from the handler value.
      const bsVal = !boatSpeedHandler.stale && typeof boatSpeedHandler.value === 'number' ? boatSpeedHandler.value : 0;
      boatSpeed.setVectorValue({ x: bsVal, y: 0 });

      // --- Misalignment ---
      misalignIn.copyFrom(calculatedWind);
      if (options.correctForMisalign) {
        const misalignValue = isNaN(options.sensorMisalignment) ? 0 : options.sensorMisalignment;
        calculatedWind.rotate(-misalignValue * Math.PI / 180);
      }
      misalignOut.copyFrom(calculatedWind);

      // --- Mast rotation ---
      mastRotIn.copyFrom(calculatedWind);
      if (options.correctForMastRotation && mast && mast.stale === false) {
        const mastValue = isNaN(mast.value) ? 0 : mast.value;
        calculatedWind.rotate(-mastValue);
      }
      mastRotOut.copyFrom(calculatedWind);

      // --- Mast heel ---
      mastHeelIn.copyFrom(calculatedWind);
      if (options.correctForMastHeel && attitude && attitude.stale === false) {
        calculatedWind.xValue = calculatedWind.x / Math.cos(attitude.value.pitch);
        calculatedWind.yValue = calculatedWind.y / Math.cos(attitude.value.roll);
      }
      mastHeelOut.copyFrom(calculatedWind);

      // --- Mast movement ---
      // sensorSpeed is kept current by attitude.onChange; just apply it here if enabled.
      mastMoveIn.copyFrom(calculatedWind);
      if (options.correctForMastMovement && attitude && attitude.stale === false) {
        calculatedWind.substract(sensorSpeed);
      }
      mastMoveOut.copyFrom(calculatedWind);

      // --- Upwash ---
      upwashIn.copyFrom(calculatedWind);
      // Always compute the angle for display (even when correction is disabled).
      const computedUpwash = approximateUpwash(calculatedWind.angle);
      upwashAngle.value = computedUpwash;
      upwashAngle.stale = false;
      if (options.correctForUpwash) {
        calculatedWind.rotate(-computedUpwash);
      }
      upwashOut.copyFrom(calculatedWind);

      // --- Leeway ---
      leewayIn.copyFrom(calculatedWind);
      if (options.correctForLeeway && leewayHandler && leewayHandler.stale === false) {
        calculatedWind.rotate(-leewayHandler.value);
      }
      leewayOut.copyFrom(calculatedWind);

      // --- True wind (always active; no calculatedWind output) ---
      trueWindIn.copyFrom(calculatedWind);
      trueWind.copyFrom(calculatedWind);
      trueWind.substract(boatSpeed);

      // --- Height / wind gradient ---
      heightIn.copyFrom(trueWind);
      if (options.correctForHeight) {
        trueWind.scale(approximateWindGradient());
        calculatedWind.copyFrom(trueWind);
        calculatedWind.add(boatSpeed);
      }
      heightOut.copyFrom(trueWind);  // always the height-corrected true wind (= heightIn if disabled)

      // --- Back-calculate apparent wind ---
      // calculatedWind at this point = corrected apparent wind (trueWind + boatSpeed,
      // possibly height-adjusted). Snapshot it; it is sent to Signal K if enabled.
      backCalcOut.copyFrom(calculatedWind);

      // --- Ground wind ---
      groundWindIn.copyFrom(calculatedWind);
      if (options.calculateGroundWind && groundSpeed && groundSpeed.stale === false && heading && heading.stale === false) {
        groundWind.copyFrom(calculatedWind);
        groundWind.rotate(heading.value);
        groundWind.substract(groundSpeed);
      }

      // Build outputs to send based on current options
      const outputsToSend = [];
      outputsToSend.push(trueWind);
      if (options.backCalculateApparentWind) {
        outputsToSend.push(calculatedWind);
      }
      if (options.calculateGroundWind) {
        outputsToSend.push(groundWind);
      }

      Polar.send(app, plugin.id, outputsToSend);

      function approximateUpwash(angle) {
        if (isNaN(options.upwashSlope) || isNaN(options.upwashOffset)) return 0;
        return (options.upwashSlope * angle + options.upwashOffset * Math.PI / 180) * Math.max(0, Math.cos(angle));
      }

      function approximateWindGradient() {
        return Math.pow((10 / options.heightAboveWater), options.windExponent);
      }

    }

    function applyOptionChanges() {
      let needsSmootherReset = false;
      let needsWindShiftReset = false;
      // Pop each key-value pair from changedOptions
      for (const key of Object.keys(changedOptions)) {
        const value = changedOptions[key];
        options[key] = value;
        switch (key) {
          case 'headingSource':
            heading.handler.source = value;
            break;
          case 'attitudeSource':
            attitude.handler.source = value;
            break;
          case 'boatSpeedSource':
            boatSpeedHandler.handler.source = value;
            break;
          case 'leewaySource':
            leewayHandler.handler.source = value;
            break;
          case 'windSpeedSource':
            apparentWind.polar.magnitudeHandler.source = value;
            apparentWind.polar.angleHandler.source = value;
            break;
          case 'rotationPath':
            mast.handler.path = value;
            break;
          case 'rotationSource':
            mast.handler.source = value;
            break;
          case 'groundSpeedSource':
            groundSpeed.polar.magnitudeHandler.source = value;
            groundSpeed.polar.angleHandler.source = value;
            break;
          case 'preventDuplication':
            apparentWind.polar.magnitudeHandler.passOn = !value;
            apparentWind.polar.angleHandler.passOn = !value;
            break;
          case 'smootherClass':
          case 'smootherTau':
          case 'smootherTimeSpan':
          case 'smootherSteadyState':
            // Handled in bulk after the loop — just accumulate into options.
            needsSmootherReset = true;
            break;
          case 'attitudeSmootherClass':
          case 'attitudeSmootherTau':
          case 'attitudeSmootherTimeSpan':
          case 'attitudeSmootherSteadyState':
            needsSmootherReset = true;
            break;
          case 'windShiftFastClass':
          case 'windShiftFastTau':
          case 'windShiftFastTimeSpan':
          case 'windShiftFastSteadyState':
          case 'windShiftSlowClass':
          case 'windShiftSlowTau':
          case 'windShiftSlowTimeSpan':
          case 'windShiftSlowSteadyState':
            needsWindShiftReset = true;
            break;
        }
        delete changedOptions[key];
      }

      // Apply smoother changes in one pass so class and options are consistent.
      if (needsSmootherReset) {
        const NewSmootherClass = resolveSmootherClass(options.smootherClass);
        const newSmootherOptions = buildSmootherOptions(options);
        // Set options first so setSmootherClass picks them up if it reuses current options.
        [heading, mast, boatSpeedHandler, leewayHandler].forEach(h => {
          if (h) { h.setSmootherOptions(newSmootherOptions); h.setSmootherClass(NewSmootherClass); }
        });
        [apparentWind, groundSpeed].forEach(p => {
          if (p) { p.setSmootherOptions(newSmootherOptions); p.setSmootherClass(NewSmootherClass); }
        });
        // Attitude has its own smoother settings.
        // Also reset derivative state so the discontinuity does not produce a spike.
        if (attitude) {
          attitude.setSmootherOptions(buildAttitudeSmootherOptions(options));
          attitude.setSmootherClass(resolveSmootherClass(options.attitudeSmootherClass));
          attLastTime = null;
          attPrevious = null;
        }
      }

      if (needsWindShiftReset) {
        if (windShiftFast) {
          windShiftFast.setSmootherOptions(buildWindShiftFastOptions(options));
          windShiftFast.setSmootherClass(resolveSmootherClass(options.windShiftFastClass));
        }
        if (windShiftSlow) {
          windShiftSlow.setSmootherOptions(buildWindShiftSlowOptions(options));
          windShiftSlow.setSmootherClass(resolveSmootherClass(options.windShiftSlowClass));
        }
      }

      saveOptions();
    }
  }






  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        isRunning = false;
        reportFull = null;
        heading = heading?.terminate(app);
        mast = mast?.terminate(app);
        attitude = attitude?.terminate(app);
        sensorSpeed = sensorSpeed?.terminate(app);
        boatSpeedHandler = boatSpeedHandler?.terminate(app);
        leewayHandler = leewayHandler?.terminate(app);
        boatSpeed = null;
        groundSpeed = groundSpeed?.terminate(app);
        misalignIn = null;  misalignOut = null;
        mastRotIn  = null;  mastRotOut  = null;
        mastHeelIn = null;  mastHeelOut = null;
        mastMoveIn = null;  mastMoveOut = null;
        upwashIn   = null;  upwashOut   = null;
        leewayIn   = null;  leewayOut   = null;
        trueWindIn = null;
        heightIn   = null;  heightOut   = null;
        backCalcOut = null;
        groundWindIn = null;
        upwashAngle  = null;
        windShiftFast = windShiftFast?.terminate();
        windShiftSlow = windShiftSlow?.terminate();
        windShift     = null;
        app.debug("plugin stopped");
        app.setPluginStatus("Stopped");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };
  return plugin;
}
