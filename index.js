const { MessageHandler, MessageHandlerDamped, Polar, PolarDamped, SI, Reporter } = require('signalkutilities');

module.exports = function (app) {

  let options = {};
  let isRunning = false;

  const plugin = {};
  plugin.id = "AdvancedWind";
  plugin.name = "Advanced Wind";
  plugin.description = "A plugin that calculates true wind while optionally correcting for vessel motion, upwash, leeway and mast height.";
  plugin.schema = {


    type: "object",
    properties: {
      headingSource: {
        type: "string",
        title: "Heading Source",
        description: "The source (name.id) to filter heading on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      attitudeSource: {
        type: "string",
        title: "Attitude Source",
        description: "The source (name.id) to filter attitude on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      boatSpeedSource: {
        type: "string",
        title: "Boat Speed Source",
        description: "The source (name.id) to filter boat speed on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      windSpeedSource: {
        type: "string",
        title: "Wind Speed Source",
        description: "The source (name.id) to filter wind speed on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      rotationPath: {
        type: "string",
        title: "Path for mast rotation",
        description: "Enter the path for mast rotation.",
      },
      rotationSource: {
        type: "string",
        title: "Mast rotation Source",
        description: "The source (name.id) to filter mast rotation on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      groundSpeedSource: {
        type: "string",
        title: "Ground Speed Source",
        description: "The source (name.id) to filter ground speed on. Source name is optional and should only be set if multiple sources are available.",
        default: ""
      },
      correctForMisalign: {
        type: "boolean",
        title: "Correct for sensor misalignment",
        description: "A misaligned sensor gives faulty wind direction.",
        default: false
      },
      correctForMastRotation: {
        type: "boolean",
        title: "Correct for mast rotation",
        description: "For vessels with a rotating mast. The correction aligns the sensor with the vessel.",
        default: false
      },
      correctForHeight: {
        type: "boolean",
        title: "Normalize wind speed to 10 meters above sea level",
        description: "Wind speed increases with height above the ground or water. To compare your boat's performance to polar data (based on a 10-meter wind height), this correction adjusts measured wind speed using the height of your sensor and a wind gradient model.",
        default: false
      },
      correctForMastMovement: {
        type: "boolean",
        title: "Compensate for mast motion due to waves",
        description: "The mast amplifies the vessel's rolling and pitching, introducing errors in wind speed and angle measurements. This correction removes the influence of mast motion by accounting for the sensor's movement.",
        default: false
      },
      correctForMastHeel: {
        type: "boolean",
        title: "Adjust for sensor tilt on a heeled mast",
        description: "A heeled mast tilts the wind sensor, causing it to underreport wind speed. This correction calculates the tilt effect based on the boat's heel and pitch, restoring accurate wind measurements.",
        default: false
      },
      correctForUpwash: {
        type: "boolean",
        title: "Account for upwash distortion",
        description: "Sails bend the airflow, causing the apparent wind angle at the sensor to differ from the true wind angle. This correction estimates and compensates for upwash, improving wind direction accuracy.",
        default: false
      },
      correctForLeeway: {
        type: "boolean",
        title: "Account for leeway",
        description: "Leeway is the sideways drift of a vessel caused by wind. This correction compensates for leeway, improving wind direction accuracy.",
        default: false
      },
      calculateGroundWind: {
        type: "boolean",
        title: "Calculate ground wind",
        description: "Calculate the wind speed over ground and direction relative to true north.",
        default: false
      },
      backCalculateApparentWind: {
        type: "boolean",
        title: "Back calculate apparent wind",
        description: "Applies corrections to the apparent wind based on the vessel's motion and environmental factors.",
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
  let sensorSpeed = null;
  let boatSpeed = null;
  let boatSpeedStat = null;
  let groundSpeed = null;
  let groundSpeedStat = null;
  let groundWind = null;
  let calculatedWind = null;
  let trueWind = null;
  let apparentWind = null;
  let apparentWindStat = null;


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

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

  }


  plugin.start = (opts) => {
    app.debug("plugin started, development version");
    app.setPluginStatus("Starting");
    options = opts;
    const outputs = [];
    reportFull = new Reporter();

    // heading
    heading = new MessageHandler("heading", "navigation.headingTrue", options.headingSource);
    heading.subscribe(app, plugin.id, true, missingData);
    headingStat = new MessageHandlerDamped("heading", heading, options.timeConstant);
    heading.onChange = () => { headingStat.sample(); }

    headingStat.setDisplayAttributes({ label: "Heading" });
    reportFull.addDelta(headingStat);

    //mast rotation
    if (options.correctForMastRotation && !options.rotationPath) {
      mast = new MessageHandler("mast", options.rotationPath, options.rotationSource);
      mast.subscribe(app, plugin.id, true, missingData);
      mastStat = new MessageHandlerDamped("mast", mast, options.timeConstant);
      mast.onChange = () => { mastStat.sample(); }

      mastStat.setDisplayAttributes({ label: "Mast Rotation" });
      reportFull.addDelta(mastStat);
    }

    //attitude
    if (options.correctForMastMovement || options.correctForMastHeel) {
      attitude = new MessageHandler("attitude", "navigation.attitude", options.attitudeSource);
      attitude.value = { pitch: 0, roll: 0, yaw: 0 };
      attitude.subscribe(app, plugin.id, true, missingData);
      attitudeStat = new MessageHandlerDamped("attitude", attitude, options.timeConstant);
      attitudeStat.sample();
      attitude.onChange = () => { attitudeStat.sample(); }
      attitudeStat.setDisplayAttributes({ label: "Attitude" });
      reportFull.addAttitude(attitudeStat);
      sensorSpeed = new Polar("sensorSpeed");
      sensorSpeed.setDisplayAttributes({ label: "Speed of sensor", plane:"Boat" });
      reportFull.addPolar(sensorSpeed);
    }

    //apparent wind
    apparentWind = new Polar("apparentWind", "environment.wind.speedApparent", "environment.wind.angleApparent", options.apparentWindSource, options.apparentWindSource);
    apparentWind.subscribe(app, plugin.id, true, true, !options.preventDuplication, missingData);
    apparentWindStat = new PolarDamped("apparentWind", apparentWind, options.timeConstant, options.timeConstant);
    apparentWind.onChange = () => { apparentWindStat.sample(); }
    apparentWindStat.setDisplayAttributes({ label: "Apparent Wind", plane:"Boat" });
    reportFull.addPolar(apparentWindStat);

    // boat speed
    boatSpeed = new Polar("boatSpeed", "navigation.speedThroughWater", options.correctForLeeway ? "navigation.leewayAngle" : options.boatSpeedSource, options.boatSpeedSource);
    boatSpeed.subscribe(app, plugin.id, true, options.correctForLeeway, missingData);
    boatSpeedStat = new PolarDamped("boatSpeed", boatSpeed, options.timeConstant);
    boatSpeed.onChange = () => { boatSpeedStat.sample(); }
    boatSpeedStat.setDisplayAttributes({ label: "Boat Speed", plane:"Boat" });
    reportFull.addPolar(boatSpeedStat);

    // ground wind and ground speed
    if (options.calculateGroundWind) {
      groundWind = new Polar("groundWind", "environment.wind.speedOverGround", "environment.wind.directionTrue");
      groundWind.setAngleRange('0to2pi');
      outputs.push(groundWind);
      groundWind.setDisplayAttributes({ label: "Ground Wind", plane:"Ground" });
      reportFull.addPolar(groundWind);

      groundSpeed = new Polar("groundSpeed", "navigation.speedOverGround", "navigation.courseOverGroundTrue", options.groundSpeedSource, options.groundSpeedSource);
      groundSpeed.subscribe(app, plugin.id, true, true, true, missingData);
      groundSpeedStat = new PolarDamped("groundSpeedDamped", groundSpeed, options.timeConstant);
      groundSpeed.onChange = () => { groundSpeedStat.sample();  }
      groundSpeedStat.setDisplayAttributes({ label: "Ground Speed", plane:"Ground" });
      reportFull.addPolar(groundSpeedStat);
    }

    // calculated wind
    calculatedWind = new Polar("calculatedWind", "environment.wind.speedApparent", "environment.wind.angleApparent");
    if (options.backCalculateApparentWind) outputs.push(calculatedWind); {
      calculatedWind.setDisplayAttributes({ label: "Calculated Apparent Wind", plane:"Boat" });
      reportFull.addPolar(calculatedWind);
    }
    //true wind
    trueWind = new Polar("trueWind", "environment.wind.speedTrue", "environment.wind.angleTrueWater");
    outputs.push(trueWind);
    trueWind.setDisplayAttributes({ label: "True Wind", plane:"Boat" });
    reportFull.addPolar(trueWind);

    apparentWind.onChange = () => {
      apparentWindStat.sample();
      calculate();
    };
    isRunning = true;
    app.debug("Start wind calculations");
    app.setPluginStatus("Running");


    function missingData(handler) {
      //app.debug(`Missing data for ${handler.path}`);
    }


    function calculate() {
      calculatedWind.copyFrom(apparentWindStat);

      if (options.correctForMisalign) {
        calculatedWind.rotate(-options.sensorMisalignment * Math.PI / 180);
      }


      if (options.correctForUpwash) {
        calculatedWind.rotate(-approximateUpwash(calculatedWind.angle));
      }

      if (options.correctForLeeway) {
        calculatedWind.rotate(-boatSpeedStat.angle);
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


    function approximateUpwash(angle) {
      return (options.upwashSlope * angle + options.upwashOffset * Math.PI / 180) * Math.max(0, Math.cos(angle));
    }

    function approximateWindGradient() {
      return Math.pow((10 / options.heightAboveWater), options.windExponent);
    }

    let lastTime = null;
    let previous = null;
    function calculateRotation(current) {
      speed = { roll: 0, pitch: 0, yaw: 0 };
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




  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        isRunning = false;
        reportFull = null;
        heading = heading?.terminate(app);
        headingStat = null;
        options = {};
        reportFull = null;
        //heading = null;
        mast = mast?.terminate(app);
        mastStat = null;
        attitude = attitude?.terminate(app);
        attitudeStat = null;
        sensorSpeed = sensorSpeed?.terminate(app);
        boatSpeed = boatSpeed?.terminate(app);
        boatSpeedStat = null;
        groundSpeed = groundSpeed?.terminate(app);
        groundSpeedStat = null;
        apparentWind = apparentWind?.terminate(app);
        apparentWindStat = null;
        calculatedWind = calculatedWind?.terminate(app);
        trueWind = trueWind?.terminate(app) ;
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