const { Delta, PolarDelta } = require('./pluginUtils.js');

class Reporter {
  constructor() {
    this.report = {};
    this.options = null;
  }

  newReport(timestamp, options) {
    this.report = {
      timestamp: timestamp,
      options: options,
      windSteps: [
      ],
      boatSteps: [
      ],
      attitudeSteps: [
      ],
      deltas: [
      ]
    };
  }

  toKnots(speed) {
    return 1.94384 * speed;
  }

  toDegrees(angle) {
    return angle * 180 / Math.PI;
  }


  addBoat(label, polar) {
    this.report.boatSteps.push(
      {
        label: label,
        speed: this.toKnots(polar.speed.value),
        angle: this.toDegrees(polar.angle.value)
      });
  }

  addWind(label, polar) {
    this.report.windSteps.push(
      {
        label: label,
        speed: this.toKnots(polar.speed.value),
        angle: this.toDegrees(polar.angle.value)
      });
  }

  addAttitude(label, delta) {
    this.report.attitudeSteps.push(
      {
        label: label,
        roll: this.toDegrees(delta.value.roll),
        pitch: this.toDegrees(delta.value.pitch),
      }
    );
  }

  addRotation(label, value) {
    this.report.attitudeSteps.push(
      {
        label: label,
        roll: this.toDegrees(value.roll),
        pitch: this.toDegrees(value.pitch),
      }
    );
  }

  addDelta(label, value) {
    this.report.deltas.push(
      {
        label: label,
        value: this.toDegrees(value.value),
      }
    );

  }

  getReport() {
    return this.report;
  }
}



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
      preventDuplication: {
        type: "boolean",
        title: "Replace apparent wind",
        description: "Replace incoming apparent wind with corrected apparent wind to prevent duplication of apparent wind delta's",
        default : true
      },
      normalizeDirection: {
        type: "boolean",
        title: "Normalize wind direction",
        description: "Normalize wind direction values to be always positive (0 - 2π)",
        default: false,
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
      kFactor: {
        type: "number",
        title: "Leeway k-factor",
        description: "Defines the effect of heel angle on leeway. Boats with higher centers of gravity have higher values. Formula used: k * heel / (speed * speed). ",
        default: 10,
      },
      timeConstant: {
        type: "number",
        title: "Output smoothing time constant",
        description: "Smooths true wind and back-calculated apparent wind outputs. A time constant of 0 disables smoothing, while higher values provide more stable readings.",
        default: 1,
        minimum: 0,
        maximum: 10
      },
    }
  };

  var heading, mast, attitude, previousAttitude, apparentWind, boatSpeed, groundSpeed, calculatedWind, trueWind, groundWind, sensorSpeed, reporter;




  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reporter?.getReport());
      }

    });

    router.get('/getVectors', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        const v = { height: options.heightAboveWater, deltas: [], polars: [] };
        const d = [heading];
        const p = [apparentWind, trueWind];
        if (options.correctForMastHeel || options.correctForMastMovement) d.push(attitude);
        if (options.correctForMastMovement) p.push(sensorSpeed);
        if (options.backCalculate) p.push(calculatedWind);
        if (options.correctForMastRotation) d.push(mast);
        if (options.calculateGroundWind) {
          p.push(groundWind);
          p.push(groundSpeed);
        }
        if (options.correctForLeeway)
          p.push(calculatedBoat);
        else
          p.push(boatSpeed);

        p.forEach(polar => {
          v.polars.push({
            id: polar.id,
            plane: polar.plane,
            label: polar.label,
            speed: polar.speed.value,
            angle: polar.angle.value,
          });
        });
        d.forEach(delta => {
          v.deltas.push({
            id: delta.id,
            value: delta.value,
          });
        });
        res.json(v);
      }
    });

  }


  plugin.start = (opts) => {
    app.debug("plugin started");
    options = opts;

    function calculate(timestamp) {
      const timeConstant = options.timeConstant;
      reporter.newReport(timestamp, options);
      calculatedWind.copyFrom(apparentWind);
      calculatedBoat.copyFrom(boatSpeed);
      reporter.addWind("apparent wind", calculatedWind);
      reporter.addBoat("speed through water", boatSpeed);

      if (options.correctForMisalign) {
        calculatedWind.rotate(-options.sensorMisalignment * Math.PI / 180);
        reporter.addWind("correct for misalignment", calculatedWind);
      }
      if (options.correctForUpwash) {
        calculatedWind.rotate(-approximateUpwash(calculatedWind));
        reporter.addWind("correct for upwash", calculatedWind);
      }
      if (options.correctForMastHeel || options.correctForMastMovement) {
        reporter.addAttitude("Attitude (°)", attitude);
      }
      if (options.correctForMastHeel) {
        wind = calculatedWind.getVectorValue();
        wind.x = wind.x / Math.cos(attitude.value.pitch);
        wind.y = wind.y / Math.cos(attitude.value.roll);
        calculatedWind.setVectorValue(wind);
        reporter.addWind("correct for mast heel", calculatedWind);
      }
      if (options.correctForMastMovement) {
        const rotation = calculateRotation(attitude, previousAttitude);
        const r = options.heightAboveWater;
        sensorSpeed.setVectorValue({ x: rotation.pitch * r, y: rotation.roll * r });
        //const sensorSpeed = { x: rotation.pitch * r, y: rotation.roll * r };
        calculatedWind.substract(sensorSpeed);
        reporter.addWind("sensor speed", sensorSpeed);
        reporter.addRotation("Rotation (°/s)", rotation);
        reporter.addWind("correct for mast movement", calculatedWind);
      }
      if (options.correctForMastRotation) {
        calculatedWind.rotate(-mast.value);
        reporter.addWind("correct for mast rotation", calculatedWind);
        reporter.addDelta("mast angle", mast);
      }
      if (options.correctForLeeway) {
        calculatedBoat.angle.value = approximateLeeway(calculatedBoat, calculatedWind, attitude);
        reporter.addBoat("correct for leeway", calculatedBoat);
        calculatedBoat.angle.sendDelta();
      }
      trueWind.copyFrom(calculatedWind);
      trueWind.substract(calculatedBoat);
      reporter.addWind("calculate true wind", trueWind);
      if (options.correctForHeight) {
        trueWind.scale(approximateWindGradient())
        reporter.addWind("normalise to 10 meters", trueWind);
      }
      calculatedWind.copyFrom(trueWind);
      calculatedWind.add(boatSpeed);
      groundWind.copyFrom(calculatedWind);
      groundWind.rotate(heading.value);
      groundWind.substract(groundSpeed);
      //groundWind.rotate(heading.value);
      if (timeConstant > 0) {
        trueWind.smoothen(timeConstant);
        reporter.addWind("smoothen true wind", trueWind);
      }
      if (options.normalizeDirection) {
          trueWind.normalize();
      }
      trueWind.sendDelta();

      reporter.addWind("back calculate apparent wind", calculatedWind);
      if (timeConstant > 0) {
        calculatedWind.smoothen(timeConstant);
        reporter.addWind("smoothen apparent wind", calculatedWind);
      }
      calculatedWind.sendDelta();

      if (options.calculateGroundWind) {
        reporter.addWind("calculate ground wind", groundWind);
        reporter.addBoat("speed over ground", groundSpeed);
        reporter.addDelta("heading", heading);

        if (timeConstant > 0) {
          groundWind.smoothen(timeConstant);
          reporter.addWind("smoothen ground wind", groundWind);
        }
        if (options.normalizeDirection) {
            groundWind.normalize();
        }
        groundWind.sendDelta();
      }
      if (attitude.timestamp - previousAttitude.timestamp >= 100) {
        // time difference must be big enough to get a reliable value for rotation
        previousAttitude.copyFrom(attitude);
      }
    }

    function approximateUpwash(wind) {
      return (options.upwashSlope * wind.angle.value + options.upwashOffset * Math.PI / 180) * Math.max(0, Math.cos(wind.angle.value));
    }

    function approximateWindGradient(wind) {
      return Math.pow((10 / options.heightAboveWater), options.windExponent);
    }

    function approximateLeeway(boat, wind, attitude) {
      //Older formula: return options.leewaySpeed * (boat.speed.value / wind.speed.value) + options.leewayAngle * Math.sin(attitude.value.roll);
      //current formula (K * heel) / (speed * speed)
      if (boat.speed.value == 0) return 0;
      const k = options.kFactor / (Math.pow(1.94384, 2)); // the formula is known to be using knots and degrees. This is a correction so the formula can be used in its known units.
      const direction = wind.angle.value > 0 ? -1 : 1;
      const leeway = direction * k * Math.abs(attitude.value.roll) / (Math.pow(boat.speed.value, 2));
      return (leeway);
    }

    function calculateRotation(current, previous) {
      const deltaT = (current.timestamp - previous.timestamp) / 1000;
      if (deltaT == 0) return { roll: 0, pitch: 0, yaw: 0 };
      return {
        roll: (current.value.roll - previous.value.roll) / deltaT,
        pitch: (current.value.pitch - previous.value.pitch) / deltaT,
        yaw: (current.value.yaw - previous.value.yaw) / deltaT
      }
    }

    heading = new Delta(app, plugin.id, "navigation.headingTrue");
    mast = new Delta(app, plugin.id, options.rotationPath);
    attitude = new Delta(app, plugin.id, "navigation.attitude");
    attitude.value = { pitch: 0, roll: 0, yaw: 0 }; //prevents errors when there is no attitude sensor
    previousAttitude = new Delta(app, plugin.id, "navigation.attitude");
    previousAttitude.value = { pitch: 0, roll: 0, yaw: 0 };
    apparentWind = new PolarDelta(app, plugin.id, "environment.wind.speedApparent", "environment.wind.angleApparent");
    boatSpeed = new PolarDelta(app, plugin.id, "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    groundSpeed = new PolarDelta(app, plugin.id, "navigation.speedOverGround", "navigation.courseOverGroundTrue");
    calculatedWind = new PolarDelta(app, plugin.id, "environment.wind.speedApparent", "environment.wind.angleApparent");
    trueWind = new PolarDelta(app, plugin.id, "environment.wind.speedTrue", "environment.wind.angleTrueWater");
    groundWind = new PolarDelta(app, plugin.id, "environment.wind.speedOverGround", "environment.wind.directionTrue");
    calculatedBoat = new PolarDelta(app, plugin.id, "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    sensorSpeed = new PolarDelta(app, plugin.id, null, null);

    heading.setId("heading");
    mast.setId("mast","ref_boat","mast rotation");
    attitude.setId("attitude");
    apparentWind.setId("apparentWind", "ref_mast", "apparent wind");
    calculatedWind.setId("calculatedWind", "ref_boat", "apparent wind");
    trueWind.setId("trueWind", "ref_boat", "true wind");
    groundWind.setId("groundWind", "ref_ground", "ground wind");
    calculatedBoat.setId("boatSpeed", "ref_boat", "speed through water");
    boatSpeed.setId("boatSpeed", "ref_boat", "speed through water");
    groundSpeed.setId("groundSpeed", "ref_ground", "speed over ground");
    sensorSpeed.setId("sensorSpeed", "ref_mast", "sensor");

    reporter = new Reporter();

    boatSpeed.speed.subscribe(unsubscribes, "instant");
    groundSpeed.subscribe(unsubscribes, "instant");
    heading.subscribe(unsubscribes, "instant");
    attitude.subscribe(unsubscribes, "instant");
    mast.subscribe(unsubscribes, "instant");
    if (options.preventDuplication) {
      apparentWind.catchDeltas(calculate);
    } 
    else {
      apparentWind.subscribe(unsubscribes, "instant");
      apparentWind.angle.onChange = calculate;
    }
    isRunning = true;
  }


  plugin.stop = () => {
    isRunning = false;
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    options = {};
    heading = null;
    mast = null;
    attitude = null;
    previousAttitude = null;
    apparentWind = null;
    boatSpeed = null;
    groundSpeed = null;
    calculatedWind = null;
    trueWind = null;
    groundWind = null;
    sensorSpeed = null;
    reporter = null;
  };
  return plugin;
};
