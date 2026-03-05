const { Polar, Reporter, ExponentialSmoother, MovingAverageSmoother, KalmanSmoother, MessageSmoother, createSmoothedPolar, createSmoothedHandler } = require('signalkutilities');
const path = require('path');

module.exports = function (app) {
  const currentVersion = "3.0";

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
    'timeConstant': 1,

    // Data Sources
    'headingSource': '',
    'attitudeSource': '',
    'boatSpeedSource': '',
    'leewaySource': '',
    'windSpeedSource': '',
    'rotationSource': '',
    'groundSpeedSource': ''
  };
  let isRunning = false;

  function readOptions() {
    const stored = app.readPluginOptions();
    // Unwrap double-nested configuration if present (migration)
    let temp = stored.configuration || {};
    app.debug("reading options:", temp);
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
    else if (temp.version === currentVersion) {
      options = { ...temp };
      return;
    }
  }

  function saveOptions() {
    app.savePluginOptions({ ...options }, (err) => {
      if (err) {
        app.error(`Error saving plugin options: ${err.message}`);
      } else {
        app.debug("Plugin options saved successfully");
      }
    });
  }

  const plugin = {};
  plugin.id = "AdvancedWind";
  plugin.name = "Advanced Wind";
  plugin.description = "A plugin that calculates true wind while optionally correcting for vessel motion, upwash, leeway and mast height.";
  // Plugin is configured via the custom webapp (insight.html), not the Signal K admin UI.
  plugin.schema   = { type: "object", properties: {} };
  plugin.uiSchema = {};

  // --- Archived schema (kept for reference) ---
  // plugin.schema = {
  //   type: "object",
  //   properties: {
  //     corrections: {
  //       type: "object",
  //       title: "Corrections",
  //       description: "Enable and configure wind corrections.",
  //       properties: {
  //         correctForMisalign: {
  //           type: "boolean",
  //           title: "Correct for sensor misalignment",
  //           description: "A misaligned sensor gives faulty wind direction.",
  //           default: false
  //         },
  //         correctForMastRotation: {
  //           type: "boolean",
  //           title: "Correct for mast rotation",
  //           description: "For vessels with a rotating mast. The correction aligns the sensor with the vessel.",
  //           default: false
  //         },
  //         correctForMastHeel: {
  //           type: "boolean",
  //           title: "Adjust for sensor tilt on a heeled mast",
  //           description: "A heeled mast tilts the wind sensor, causing it to underreport wind speed. This correction calculates the tilt effect based on the boat's heel and pitch, restoring accurate wind measurements.",
  //           default: false
  //         },
  //         correctForMastMovement: {
  //           type: "boolean",
  //           title: "Compensate for mast motion due to waves",
  //           description: "The mast amplifies the vessel's rolling and pitching, introducing errors in wind speed and angle measurements. This correction removes the influence of mast motion by accounting for the sensor's movement.",
  //           default: false
  //         },
  //         correctForUpwash: {
  //           type: "boolean",
  //           title: "Account for upwash distortion",
  //           description: "Sails bend the airflow, causing the apparent wind angle at the sensor to differ from the true wind angle. This correction estimates and compensates for upwash, improving wind direction accuracy.",
  //           default: false
  //         },
  //         correctForLeeway: {
  //           type: "boolean",
  //           title: "Account for leeway",
  //           description: "Leeway is the sideways drift of a vessel caused by wind. This correction compensates for leeway, improving wind direction accuracy.",
  //           default: false
  //         },
  //         correctForHeight: {
  //           type: "boolean",
  //           title: "Normalize wind speed to 10 meters above sea level",
  //           description: "Wind speed increases with height above the ground or water. To compare your boat's performance to polar data (based on a 10-meter wind height), this correction adjusts measured wind speed using the height of your sensor and a wind gradient model.",
  //           default: false
  //         }
  //       }
  //     },
  //     outputOptions: {
  //       type: "object",
  //       title: "Output Options",
  //       description: "Choose output options.",
  //       properties: {
  //         calculateGroundWind: {
  //           type: "boolean",
  //           title: "Calculate ground wind",
  //           description: "Calculate the wind speed over ground and direction relative to true north.",
  //           default: false
  //         },
  //         backCalculateApparentWind: {
  //           type: "boolean",
  //           title: "Back calculate apparent wind",
  //           description: "Applies corrections to the apparent wind based on the vessel's motion and environmental factors.",
  //           default: true
  //         },
  //         preventDuplication: {
  //           type: "boolean",
  //           title: "Replace apparent wind",
  //           description: "Replace incoming apparent wind with corrected apparent wind to prevent duplication of apparent wind delta's",
  //           default: true
  //         }
  //       }
  //     },
  //     parameters: {
  //       type: "object",
  //       title: "Parameters",
  //       description: "Set parameters for the wind corrections.",
  //       properties: {
  //         sensorMisalignment: {
  //           type: "number",
  //           title: "Misalignment of the wind sensor (°)",
  //           description: "Enter the misalignment of the windsensor in degrees",
  //           default: 0,
  //         },
  //         heightAboveWater: {
  //           type: "number",
  //           title: "Wind sensor height Above Water (meters)",
  //           description: "Enter the height of the wind sensor above the waterline in meters. This is used for wind gradient correction and mast motion correction.",
  //           default: 15
  //         },
  //         windExponent: {
  //           type: "number",
  //           title: "Wind gradient parameter (α)",
  //           description: "This parameter defines how wind speed changes with height. Typical values are 0.1 to 0.15, depending on atmospheric conditions.",
  //           default: 0.14
  //         },
  //         upwashSlope: {
  //           type: "number",
  //           title: "Upwash slope (α)",
  //           description: "Defines the sensitivity of upwash correction to apparent wind angle.",
  //           default: 0.05,
  //           minimum: 0,
  //           maximum: 0.3,
  //         },
  //         upwashOffset: {
  //           type: "number",
  //           title: "Upwash offset(°) (β)",
  //           description: "Adds a constant offset to the upwash correction.",
  //           default: 1.5,
  //           minimum: -1,
  //           maximum: 4
  //         },
  //         timeConstant: {
  //           type: "number",
  //           title: "Input smoothing time constant",
  //           description: "Smooths input values exponentially. A time constant of 0 disables smoothing.",
  //           default: 1,
  //           minimum: 0,
  //           maximum: 10
  //         }
  //       }
  //     },
  //     dataSources: {
  //       type: "object",
  //       title: "Data Sources",
  //       description: "Select the data sources for the input paths.",
  //       properties: {
  //         headingSource:    { type: "string", title: "Heading Source",      default: "" },
  //         attitudeSource:   { type: "string", title: "Attitude Source",     default: "" },
  //         boatSpeedSource:  { type: "string", title: "Boat Speed Source",   default: "" },
  //         windSpeedSource:  { type: "string", title: "Wind Speed Source",   default: "" },
  //         rotationPath:     { type: "string", title: "Path for mast rotation" },
  //         rotationSource:   { type: "string", title: "Mast rotation Source", default: "" },
  //         groundSpeedSource:{ type: "string", title: "Ground Speed Source", default: "" }
  //       }
  //     }
  //   }
  // };
  //
  // plugin.uiSchema = {
  //   'ui:order': ['corrections', 'outputOptions', 'parameters', 'dataSources'],
  //   corrections:   { 'ui:options': { tab: 'Corrections',    description: 'Enable and configure wind corrections.' } },
  //   outputOptions: { 'ui:options': { tab: 'Output Options', description: 'Choose output options.' } },
  //   parameters:    { 'ui:options': { tab: 'Parameters',     description: 'Set parameters for the wind corrections.' } },
  //   dataSources:   { 'ui:options': { tab: 'Data Sources',   description: 'Select the data sources for the input paths.' } }
  // };
  // --- End archived schema ---

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


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');
    // Load options here — app is fully initialized by the time Signal K calls
    // registerWithRouter, so app.readPluginOptions() is available. This ensures
    // the /config GET endpoint serves real data before plugin.start() is called.
    readOptions();


    router.get('/getResults', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reportFull?.report());
      }

    });

    router.get('/getVectors', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reportFull?.report());
      }
    });

    // Endpoint for full Reporter-based state snapshot
    router.get('/state', (req, res) => {
      if (!isRunning || !reportFull) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        try {
          res.json(reportFull.report());
        } catch (err) {
          app.error(`AdvancedWind /state error: ${err.message}`);
          res.status(500).json({ error: "Failed to build state report" });
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
  plugin.start = () => {
    app.debug("plugin started");
    app.setPluginStatus("Starting");
    // Store options at module scope so runtime changes via /config
    // can be picked up by the calculation logic. Guard against
    // non-object values coming from a corrupted configuration file.
    readOptions();
    const outputs = [];
    reportFull = new Reporter();
    let lastTime = null;
    let previous = null;
    
    let smootherOptions = { timeConstant: options.timeConstant, processVariance: 1, measurementVariance: 4, timeSpan: 1 };

    // heading
    heading = createSmoothedHandler({
      id: "heading",
      path: "navigation.headingTrue",
      source: options.headingSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Heading" },
    });

    //mast rotation (always create handler; options decide whether it is used)
    mast = createSmoothedHandler({
      id: "mast",
      path: options.rotationPath,
      source: options.rotationSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Mast Rotation" },
    });

    //attitude (always create handler; corrections decide whether it is used)
    attitude = createSmoothedHandler({
      id: "attitude",
      path: "navigation.attitude",
      source: options.attitudeSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Attitude" }
    });
    sensorSpeed = new Polar(app, plugin.id, "sensorSpeed");
    sensorSpeed.setDisplayAttributes({ label: "Speed of sensor", plane: "Boat" });

    // Snapshot polars for per-step before/after inspection
    misalignIn  = new Polar(app, plugin.id, "misalignIn");  misalignIn.setDisplayAttributes({  label: "Before misalignment",      plane: "Boat" });
    misalignOut = new Polar(app, plugin.id, "misalignOut"); misalignOut.setDisplayAttributes({ label: "After misalignment",       plane: "Boat" });
    mastRotIn   = new Polar(app, plugin.id, "mastRotIn");   mastRotIn.setDisplayAttributes({   label: "Before mast rotation",     plane: "Boat" });
    mastRotOut  = new Polar(app, plugin.id, "mastRotOut");  mastRotOut.setDisplayAttributes({  label: "After mast rotation",      plane: "Boat" });
    mastHeelIn  = new Polar(app, plugin.id, "mastHeelIn");  mastHeelIn.setDisplayAttributes({  label: "Before mast heel",         plane: "Boat" });
    mastHeelOut = new Polar(app, plugin.id, "mastHeelOut"); mastHeelOut.setDisplayAttributes({ label: "After mast heel",          plane: "Boat" });
    mastMoveIn  = new Polar(app, plugin.id, "mastMoveIn");  mastMoveIn.setDisplayAttributes({  label: "Before mast movement",     plane: "Boat" });
    mastMoveOut = new Polar(app, plugin.id, "mastMoveOut"); mastMoveOut.setDisplayAttributes({ label: "After mast movement",      plane: "Boat" });
    upwashIn    = new Polar(app, plugin.id, "upwashIn");    upwashIn.setDisplayAttributes({    label: "Before upwash",            plane: "Boat" });
    upwashOut   = new Polar(app, plugin.id, "upwashOut");   upwashOut.setDisplayAttributes({   label: "After upwash",             plane: "Boat" });
    leewayIn    = new Polar(app, plugin.id, "leewayIn");    leewayIn.setDisplayAttributes({    label: "Before leeway",            plane: "Boat" });
    leewayOut   = new Polar(app, plugin.id, "leewayOut");   leewayOut.setDisplayAttributes({   label: "After leeway",             plane: "Boat" });
    trueWindIn  = new Polar(app, plugin.id, "trueWindIn");  trueWindIn.setDisplayAttributes({  label: "Corrected apparent wind",  plane: "Boat" });
    heightIn    = new Polar(app, plugin.id, "heightIn");    heightIn.setDisplayAttributes({    label: "True wind (before height norm.)", plane: "Boat" });
    heightOut   = new Polar(app, plugin.id, "heightOut");   heightOut.setDisplayAttributes({   label: "True wind (after height norm.)",  plane: "Boat" });
    backCalcOut = new Polar(app, plugin.id, "backCalcOut"); backCalcOut.setDisplayAttributes({ label: "Corrected apparent wind",  plane: "Boat" });
    groundWindIn = new Polar(app, plugin.id, "groundWindIn"); groundWindIn.setDisplayAttributes({ label: "Corrected apparent wind", plane: "Boat" });

    //apparent wind
    apparentWind = createSmoothedPolar({
      id: "apparentWind",
      pathMagnitude: "environment.wind.speedApparent",
      pathAngle: "environment.wind.angleApparent",
      subscribe: true,
      sourceMagnitude: options.apparentWindSource,
      sourceAngle: options.apparentWindSource,
      app: app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Observed apparent Wind", plane: "Boat" },
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
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Boat Speed", unit: "m/s" },
    });

    leewayHandler = createSmoothedHandler({
      id: "leeway",
      path: "navigation.leewayAngle",
      source: options.leewaySource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Leeway Angle", unit: "rad" },
    });

    // Forward-only polar: angle is always 0. Updated each cycle from boatSpeedHandler.
    boatSpeed = new Polar(app, plugin.id, "boatSpeed");
    boatSpeed.setDisplayAttributes({ label: "Boat Speed", plane: "Boat" });

    // ground wind and ground speed (always created; options decide whether used/output)
    groundWind = new Polar(app, plugin.id, "groundWind");
    groundWind.setMagnitudeSubscription("environment.wind.speedOverGround");
    groundWind.setAngleSubscription("environment.wind.directionTrue");
    groundWind.setAngleRange('0to2pi');
    groundWind.setDisplayAttributes({ label: "Ground Wind", plane: "Ground" });

    groundSpeed = createSmoothedPolar({
      id: "groundSpeed",
      pathMagnitude: "navigation.speedOverGround",
      pathAngle: "navigation.courseOverGroundTrue",
      subscribe: true,
      sourceMagnitude: options.groundSpeedSource,
      sourceAngle: options.groundSpeedSource,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Ground Speed", plane: "Ground" },
      passOn: true,
      angleRange: '0to2pi'
    });

    // calculated wind
    calculatedWind = new Polar(app, plugin.id, "calculatedWind");
    calculatedWind.setMagnitudeSubscription("environment.wind.speedApparent");
    calculatedWind.setAngleSubscription("environment.wind.angleApparent");
    calculatedWind.setDisplayAttributes({ label: "Apparent Wind", plane: "Boat" });
    calculatedWind.angleRange = '-piToPi';

    //true wind
    trueWind = new Polar(app, plugin.id, "trueWind");
    trueWind.setMagnitudeSubscription("environment.wind.speedTrue");
    trueWind.setAngleSubscription("environment.wind.angleTrueWater");
    trueWind.setDisplayAttributes({ label: "True Wind", plane: "Boat" });
    trueWind.angleRange = '-piToPi';

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
    reportFull.addPolar(upwashIn);    reportFull.addPolar(upwashOut);
    reportFull.addPolar(leewayIn);    reportFull.addPolar(leewayOut);
    reportFull.addPolar(trueWindIn);
    reportFull.addPolar(heightIn);    reportFull.addPolar(heightOut);
    reportFull.addPolar(backCalcOut);
    reportFull.addPolar(groundWindIn);
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
      mastMoveIn.copyFrom(calculatedWind);
      if (options.correctForMastMovement && attitude && attitude.stale === false) {
        const rotation = calculateRotation(attitude.value);
        const r = options.heightAboveWater;
        const s = { x: rotation.pitch * r, y: rotation.roll * r };
        sensorSpeed.setVectorValue(s);
        calculatedWind.substract(sensorSpeed);
      }
      mastMoveOut.copyFrom(calculatedWind);

      // --- Upwash ---
      upwashIn.copyFrom(calculatedWind);
      if (options.correctForUpwash) {
        calculatedWind.rotate(-approximateUpwash(calculatedWind.angle));
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
      heightOut.copyFrom(calculatedWind);

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
        return (options.upwashSlope * angle + options.upwashOffset * Math.PI / 180) * Math.max(0, Math.cos(angle));
      }

      function approximateWindGradient() {
        return Math.pow((10 / options.heightAboveWater), options.windExponent);
      }

      function calculateRotation(current) {
        let speed = { roll: 0, pitch: 0, yaw: 0 };
        if (!lastTime) {
          lastTime = Date.now();
          previous = { ...current };
          return speed;
        }
        let now = Date.now();
        let deltaT = (now - lastTime) / 1000;
        lastTime = now;
        if (deltaT > 0) {
          speed = {
            roll: (current.roll - previous.roll) / deltaT,
            pitch: (current.pitch - previous.pitch) / deltaT,
            yaw: (current.yaw - previous.yaw) / deltaT
          };
        }
        previous = { ...current };
        return speed;
      }

    }

    function applyOptionChanges() {
      // Pop each key-value pair from changedOptions
      for (const key of Object.keys(changedOptions)) {
        const value = changedOptions[key];
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
          default:
            // Plain value options (booleans, numbers, strings) go straight into options
            options[key] = value;
            break;
        }
        delete changedOptions[key];
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
