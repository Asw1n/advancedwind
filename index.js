const { MessageHandler, MessageHandlerDamped, Polar, PolarDamped, SI, Reporter } = require('signalkutilities');

module.exports = function (app) {

  let unsubscribes = [];
  let options = {};
  let isRunning = false;

  const plugin = {};
  plugin.id = "AdvancedWind";
  plugin.name = "Advanced Wind";
  plugin.description = "A plugin that calculates true wind while optionally correcting for vessel motion, upwash, leeway and mast height.";
  plugin.schema = {


    type: "object",
    properties: {
      correctForMisalign: {
        type: "boolean",
        title: "Correct for sensor misalignment",
        description: "A misaligned sensor gives faulty wind direction."
      },
      correctForMastRotation: {
        type: "boolean",
        title: "Correct for mast rotation",
        description: "For vessels with a rotating mast. The correction aligns the sensor with the vessel."
      },
      correctForHeight: {
        type: "boolean",
        title: "Normalize wind speed to 10 meters above sea level",
        description: "Wind speed increases with height above the ground or water. To compare your boat's performance to polar data (based on a 10-meter wind height), this correction adjusts measured wind speed using the height of your sensor and a wind gradient model."
      },
      correctForMastMovement: {
        type: "boolean",
        title: "Compensate for mast motion due to waves",
        description: "The mast amplifies the vessel's rolling and pitching, introducing errors in wind speed and angle measurements. This correction removes the influence of mast motion by accounting for the sensor's movement."
      },
      correctForMastHeel: {
        type: "boolean",
        title: "Adjust for sensor tilt on a heeled mast",
        description: "A heeled mast tilts the wind sensor, causing it to underreport wind speed. This correction calculates the tilt effect based on the boat's heel and pitch, restoring accurate wind measurements."
      },
      correctForUpwash: {
        type: "boolean",
        title: "Account for upwash distortion",
        description: "Sails bend the airflow, causing the apparent wind angle at the sensor to differ from the true wind angle. This correction estimates and compensates for upwash, improving wind direction accuracy."
      },
      correctForLeeway: {
        type: "boolean",
        title: "Adjust for leeway",
        description: "The wind pushes the boat sideways, creating leeway that affects the apparent wind at the sensor. This correction estimates leeway using boat speed, wind speed, and heel angle."
      },
      calculateGroundWind: {
        type: "boolean",
        title: "Calculate ground wind",
        description: "Calculate the wind speed over ground and direction relative to true north."
      },
      backCalculateApparentWind: {
        type: "boolean",
        title: "Correct apparent wind for mast height",
        description: "Corrects apparent wind measurements for the height of the mast.",
        default: true
      },
      preventDuplication: {
        type: "boolean",
        title: "Replace apparent wind",
        description: "Replace incoming apparent wind with corrected apparent wind to prevent duplication of apparent wind delta's",
        default: true
      },
      sensorMisalignment: {
        type: "number",
        title: "Misalignment of the wind sensor (°)",
        description: "Enter the misalignment of the windsensor in degrees",
        default: 0,
      },
      rotationPath: {
        type: "string",
        title: "Path for mast rotation",
        description: "Enter the path for mast rotation.",
      },
      heightAboveWater: {
        type: "number",
        title: "Wind sensor height Above Water (meters)",
        description: "Enter the height of the wind sensor above the waterline in meters. This is used for wind gradient correction and mast motion correction.",
        default: 15
      },
      windExponent: {
        type: "number",
        title: "Wind gradient parameter (α)",
        description: "This parameter defines how wind speed changes with height.Typical values are 0.1 to 0.15, depending on atmospheric conditions. Formula used: Normalised windspeed = windspeed * (10 / sensor height above water)^α. ",
        default: 0.14
      },
      upwashSlope: {
        type: "number",
        title: "Upwash slope (α)",
        description: "Defines the sensitivity of upwash correction to apparent wind angle. For racing yachts, use 0.05 to 0.1; for cruising yachts, use 0.03 to 0.07. Formula used: Upwash Angle (°) = (α ⋅ AWA(°) + β(°)) ⋅ max(0, cos(AWA)). For racing yachts: 0.05 to 0.1, for cruising yachts: 0.03 to 0.07 ",
        default: 0.05,
        minimum: 0,
        maximum: 0.3,
      },
      upwashOffset: {
        type: "number",
        title: "Upwash offset(°) (β)",
        description: "Adds a constant offset to the upwash correction. Racing yachts typically use values between -1 and 1, while cruising yachts use 1 to 3. Formula used: Upwash Angle (°) = (α ⋅ AWA(°) + β(°)) ⋅ max(0, cos(AWA)). For racing yachts: -1 to 1, for cruising yachts: 1 to 3",
        default: 1.5,
        minimum: -1,
        maximum: 4
      },
      /*       leewaySpeed: {
              type: "number",
              title: "Leeway speed coefficient (α)",
              description: "Defines the contribution of boat speed to leeway. Wider or less efficient hulls have higher values (0.4–0.5); slender, high-performance hulls have lower values (0.3–0.4). Formula used: α ⋅ Vboat / Vwind + β ⋅ sin(Heel Angle).",
              default: 0.4,
              minumum: 0.3,
              maximum: 0.5
            },
            leewayAngle: {
              type: "number",
              title: "Leeway Heel Coefficient (β)",
              description: "Defines the effect of heel angle on leeway. Boats with higher centers of gravity have higher values (0.3–0.4); others use 0.2–0.3. Formula used: α ⋅ Vboat / Vwind + β ⋅ sin(Heel Angle). ",
              default: 0.3,
              minimum: 0.2,
              maximum: 0.4
            }, */

      timeConstant: {
        type: "number",
        title: "Input smoothing time constant",
        description: "Smooths input values exponentially. A time constant of 0 disables smoothing, while higher values provide more stable readings.",
        default: 1,
        minimum: 0,
        maximum: 10
      },
    }
  };

  let reportFull = null;
  let heading = null;
  let headingStat = null;
  let mast = null;
  let mastStat = null;
  let attitude = null;
  let attitudeStat = null;
  let previousAttitude = null;
  let sensorSpeed = null;
  let boatSpeed = null;
  let boatSpeedStat = null;
  let groundSpeed = null;
  let groundSpeedStat = null;
  let calculatedWind = null;
  let trueWind = null;


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reportFull?.getReport());
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

  }


  plugin.start = (opts) => {
    app.debug("plugin started, development version");
    app.setPluginStatus("Starting");
    options = opts;
    const candidates = [];
    const outputs = [];
    reportFull = new Reporter();

    // heading
    heading = new MessageHandler("heading", "navigation.headingTrue");
    heading.subscribe(app, plugin.id);
    candidates.push(heading);
    headingStat = new MessageHandlerDamped("headingDamped", heading, options.timeConstant);
    heading.onChange = () => { headingStat.sample(); }
    reportFull.addDelta(headingStat);

    //mast rotation
    if (options.correctForMastRotation && !options.rotationPath) {
      mast = new MeHandler('mast', options.rotationPath);
      mast.subscribe(app, plugin.id);
      candidates.push(mast);
      mastStat = new MessageHandlerDamped("mastDamped", mast, options.timeConstant);
      mast.onChange = () => { mastStat.sample(); }
    }

    //attitude
    if (options.correctForMastMovement || options.correctForMastHeel) {
      attitude = new MessageHandler("attitude", "navigation.attitude");
      attitude.value = { pitch: 0, roll: 0, yaw: 0 };
      attitude.subscribe(app, plugin.id);
      attitudeStat = new MessageHandlerDamped("attitudeDamped", attitude, options.timeConstant );
      attitudeStat.sample();
      attitude.onChange = () => {attitudeStat.sample();}
      candidates.push(attitude);
      reportFull.addAttitude(attitude);
      sensorSpeed = new Polar("sensorSpeed");
      reportFull.addPolar(sensorSpeed);
    }

    //apparent wind
    apparentWind = new Polar("apparentWind", "environment.wind.speedApparent", "environment.wind.angleApparent");
    apparentWind.subscribe(app, plugin.id, true, true, !options.preventDuplication);
    candidates.push(apparentWind);
    apparentWindStat = new PolarDamped("apparentWindDamped", apparentWind, options.timeConstant, options.timeConstant);
    apparentWind.onChange = () => { apparentWindStat.sample(); }
    reportFull.addPolar(apparentWindStat);

    // boat speed
    boatSpeed = new Polar("boatSpeed", "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    boatSpeed.subscribe(app, plugin.id, true, options.correctForLeeway);
    candidates.push(boatSpeed);
    boatSpeedStat = new PolarDamped("boatSpeedDamped", boatSpeed, options.timeConstant);
    boatSpeed.onChange = () => { boatSpeedStat.sample(); }
    reportFull.addPolar(boatSpeedStat);

    // ground wind and ground speed
    if (options.calculateGroundWind) {
      groundWind = new Polar("groundWind", "environment.wind.speedOverGround", "environment.wind.directionTrue");
      groundWind.setAngleRange('0to2pi');
      outputs.push(groundWind);

      groundSpeed = new Polar("groundSpeed", "navigation.speedOverGround", "navigation.courseOverGroundTrue", options.SOGSource, options.COGSource);
      groundSpeed.subscribe(app, plugin.id, true, true, true);
      candidates.push(groundSpeed);
      groundSpeedStat = new MessageHandlerDamped("groundSpeedDamped", groundSpeed, options.timeConstant);
      groundSpeed.onChange = () => { groundSpeedStat.sample(); }
      reportFull.addPolar(groundSpeedStat);
    }

    // calculated wind
    calculatedWind = new Polar("calculatedWind", "environment.wind.speedApparent", "environment.wind.angleApparent");
    if (options.backCalculateApparentWind) outputs.push(calculatedWind);
    reportFull.addPolar(calculatedWind);
    //true wind
    trueWind = new Polar("trueWind", "environment.wind.speedTrue", "environment.wind.angleTrueWater");
    outputs.push(trueWind);
    reportFull.addPolar(trueWind);


    app.debug("Analyzing input data");

    // Wait until all candidates have n >= 2 and no longer have lacking input data, or until 10 seconds have elapsed
    const maxWait = 10000; // 10 seconds
    const pollInterval = 200; // ms
    const startTime = Date.now();
    let intervalId = null;
    let ready = false;

    function allCandidatesReady() {
      return candidates.every(candidate => {
        const enoughSamples = typeof candidate.frequency === 'number' ;
        const notLacking = !candidate.lackingInputData();
        return enoughSamples && notLacking;
      });
    }

    function startCalculations() {
      if (ready) return;
      ready = true;
      //candidates.sort((a, b) => (a.frequency || 0) - (b.frequency || 0));
      apparentWind.onChange = () => {
        apparentWindStat.sample();
        calculate();
      };
      app.debug("Start wind calculations");
      app.setPluginStatus("Running");
      clearInterval(intervalId);
    }

    intervalId = setInterval(() => {
      if (allCandidatesReady()) {
        startCalculations();
      } else if (Date.now() - startTime >= maxWait) {
        clearInterval(intervalId); // Stop polling, do not start calculations
        app.debug("Not all inputs ready after 10 seconds, wind calculations not started.");
      }
    }, pollInterval);

    function calculate() {
      calculatedWind.copyFrom(apparentWindStat);

      if (options.correctForMisalign) {
        calculatedWind.rotate(-options.sensorMisalignment * Math.PI / 180);
      }
      if (options.correctForUpwash) {
        calculatedWind.rotate(-approximateUpwash(calculatedWind));
      }
      if (options.correctForMastHeel) {
        calculatedWind.xValue = calculatedWind.x / Math.cos(attitude.value.pitch);
        calculatedWind.yValue = calculatedWind.y / Math.cos(attitude.value.roll);
      }

      if (options.correctForMastMovement) {
        const rotation = calculateRotation(attitudeStat.value);
        const r = options.heightAboveWater;
        const s = { x: rotation.pitch * r, y: rotation.roll * r };
        sensorSpeed.setVectorValue(s);
        calculatedWind.substract(sensorSpeed);
      }

      if (options.correctForMastRotation) {
        calculatedWind.rotate(-mastStat.value);
      }
      if (options.correctForLeeway) {
        // Already taken care of by the boat speed object
      }

      trueWind.copyFrom(calculatedWind);
      trueWind.substract(boatSpeedStat);
      if (options.correctForHeight) {
        trueWind.scale(approximateWindGradient())
        calculatedWind.copyFrom(trueWind);
        calculatedWind.add(boatSpeedStat);
      }
      if (options.calculateGroundWind) {
        groundWind.copyFrom(calculatedWind);
        groundWind.rotate(heading.value);
        groundWind.substract(groundSpeed);
      }

      Polar.send(app, plugin.id, outputs);
    }
  }

  function approximateUpwash(wind) {
    return (options.upwashSlope * wind.angle.value + options.upwashOffset * Math.PI / 180) * Math.max(0, Math.cos(wind.angle.value));
  }

  function approximateWindGradient(wind) {
    return Math.pow((10 / options.heightAboveWater), options.windExponent);
  }

  let lastTime = null;
  let previous = null;
  function calculateRotation(current) {
    speed = { roll: 0, pitch: 0, yaw: 0 };
    if (!lastTime ) {
      lastTime = Date.now();
      previous = { ...current };
      return speed;
    }
    let now = Date.now();
    let deltaT = (now - lastTime) / 1000;
    lastTime = now;
    if (deltaT > 0) {
      speed = {roll: (current.roll - previous.roll) / deltaT,
        pitch: (current.pitch - previous.pitch) / deltaT,
        yaw: (current.yaw - previous.yaw) / deltaT
      };
    }
    previous = { ...current };
    return speed;
  }




  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        options = {};
        reportFull = null;
        heading = null;
        headingStat = null;
        mast = null;
        mastStat = null;
        attitude = null;
        attitudeStat = null;
        previousAttitude = null;
        sensorSpeed = null;
        boatSpeed = null;
        boatSpeedStat = null;
        groundSpeed = null;
        groundSpeedStat = null;
        calculatedWind = null;
        trueWind = null;
        app.setPluginStatus("Stopped");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };
  return plugin;
}