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
      ]
    };
  }

  toKnots(speed) {
    return 1.94384 * speed;
  }

  toDegrees(angle) {
    return angle * 180 / Math.PI;
  }


  addBoat(polar, label) {
    this.report.boatsteps.push(
      {
        label: label,
        speed: this.toKnots(polar.speed),
        angle: this.toDegrees(polar.angle)
      });
  }

  addWind(polar, label) {
    this.report.windsteps.push(
      {
        label: label,
        speed: this.toKnots(polar.speed),
        angle: this.toDegrees(polar.angle)
      });
  }

  addAttitude(delta, label) {
    this.report.attitiudeSteps.attitudeSteps.push(
      {
        label: label,
        roll: this.toDegrees(delta.value.roll),
        pitch: this.toDegrees(delta.value.pitch),
      }
    );
  }

  addRotation(delta, label) {
    this.report.attitiudeSteps.attitudeSteps.push(
      {
        label: label,
        roll: this.toKnots(delta.value.roll),
        pitch: this.toKnots(delta.value.pitch),
      }
    );
  }

  getReport() {
    return this.report;
  }
}



module.exports = function (app) {

  let unsubscribes=[];
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
      backCalculate: {
        type: "boolean",
        title: "Back calculate apparent wind",
        description: "Calculate apparent wind from true wind, effectively applying all checked corrections to apparent wind as well."
      },
      calculateGroundWind: {
        type: "boolean",
        title: "Calculate ground wind",
        description: "Calculate the wind speed over ground and direction relative to true north."
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
        description: "Defines the sensitivity of upwash correction to apparent wind angle. For racing yachts, use 0.05 to 0.1; for cruising yachts, use 0.03 to 0.07. Formula used: Upwash Angle (°) = α ⋅ AWA(°) + β(°). For racing yachts: 0.05 to 0.1, for cruising yachts: 0.03 to 0.07 ",
        default: 0.05,
        minimum: 0,
        maximum: 0.3,
      },
      upwashOffset: {
        type: "number",
        title: "Upwash offset(°) (β)",
        description: "Adds a constant offset to the upwash correction. Racing yachts typically use values between -1 and 1, while cruising yachts use 1 to 3. Formula used: Upwash Angle (°) = α ⋅ AWA(°) + β(°). For racing yachts: -1 to 1, for cruising yachts: 1 to 3",
        default: 1.5,
        minimum: -1,
        maximum: 4
      },
      leewaySpeed: {
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

  const reporter = new Reporter();

  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      res.json(reporter.getReport());
    });
    const options = app.readPluginOptions();
    app.debug(options);
  }


  plugin.start = (options) => {

    function calculate(timestamp) {
      const timeConstant = options.timeConstant / 1000;
      reporter.newReport(timestamp, options);
      calculatedWind.copyFrom(apparentWind);
      reporter.addWind("initial apparent wind value", calculatedWind);
      if (options.correctForMisalign) {
        calculatedWind.rotate(options.sensorMisalignment * Math.PI / 180);
        reporter.addWind("correct for misalignment", calculatedWind);
      }
      if (options.correctForMastRotation) {
        calculatedWind.rotate(mast.value);
        reporter.addWind( "correct for mast rotation", calculatedWind);
      }
      if (options.correctForUpwash) {
        calculatedWind.rotate(-approximateUpwash(calculatedWind));
        reporter.addWind( "correct for upwash", calculatedWind);
      }
      if (options.correctForMastHeel || options.correctForMastMovement)  {
        reporter.addAttitude("Attitude (°)", attitude);
      }    
      if (options.correctForMastHeel) {
        wind = calculatedWind.getVectorValue();
        wind.x = wind.x / Math.cos(attitude.pitch);
        wind.y = wind.y / Math.cos(attitude.roll);
        calculatedWind.setVectorValue(wind);
        reporter.addWind( "correct for mast heel", calculatedWind);
      }
      if (options.correctForMastMovement) {
        const rotation = calculateRotation(attitude, previousAttitude);
        const r = options.heightAboveWater;
        const sensorSpeed = { x: rotation.pitch * r, y: rotation.roll * r };
        wind = calculatedWind.getVectorValue();
        wind.x = wind.x - sensorSpeed.x;
        wind.y = wind.y - sensorSpeed.y;
        calculatedWind.setVectorValue(wind);
        reporter.addRotation( "Rotation (m/s)", rotation);
        reporter.addWind( "correct for mast movement", calculatedWind);
      }
      if (options.correctForLeeway) {
        boatSpeed.angle.value = approximateLeeway(boatSpeed, calculatedWind, attitude);
        reporter.addBoat( "correct for leeway", boatSpeed);
        boatSpeed.angle.sendDelta();
      }
      trueWind.copyFrom(calculatedWind);
      trueWind.substract(boatSpeed);
      reporter.addWind( "calculate true wind", trueWind);
      if (options.correctForHeight) {
        trueWind.scale(approximateWindGradient())
        reporter.addWind("normalise to 10 meters", trueWind);
      }
      calculatedWind.copyFrom(trueWind);
      calculatedWind.add(boatSpeed);
      groundWind.copyFrom(calculatedWind);
      groundWind.substract(groundSpeed);
      groundWind.rotate(-heading.value);
      if (timeConstant > 0) {
        trueWind.smoothen(timeConstant);
        reporter.addWind("smoothen true wind", trueWind);
      }
      trueWind.sendDelta();

      if (options.backCalculate) {
        reporter.addWind("back calculate apparent wind", calculatedWind);
        if (timeConstant > 0) {
          calculatedWind.smoothen(timeConstant);
          reporter.addWind("smoothen apparent wind", calculatedWind);
        }
        calculatedWind.sendDelta();
      }
      if (options.calculateGroundWind) {
        addWind(calc, "calculate ground wind", groundWind);
        if (timeConstant > 0) {
          groundWind.smoothen(timeConstant);
          reporter.addWind("smoothen ground wind", groundWind);
        }
        groundWind.sendDelta();
      }
      previousAttitude.copyFrom(attitude);
    }

    function approximateUpwash(wind) {
      return options.upwashSlope * wind.angle.value + options.upwashOffset * Math.PI / 180;
    }

    function approximateWindGradient(wind) {
      return Math.pow((10 / options.heightAboveWater), options.windExponent);
    }

    function approximateLeeway(boat, wind, attitude) {
      return options.leewaySpeed * (boat.speed.value / wind.speed.value) + options.leewayAngle * Math.sin(attitude.roll);
    }

    function calculateRotation(current, previous) {
      const deltaT = (current.timestamp - previous.timestamp) / 1000;
      if (deltaT == 0) return { roll: 0, pitch: 0, yaw: 0 };
      return {
        roll: (current.roll - previous.roll) / deltaT,
        pitch: (current.pitch - previous.pitch) / deltaT,
        yaw: (current.yaw - previous.yaw) / deltaT
      }
    }

    const apparentWind = new PolarDelta(app, plugin.id, "environment.wind.speedApparent", "environment.wind.angleApparent");
    const boatSpeed = new PolarDelta(app, plugin.id, "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    const groundSpeed = new PolarDelta(app, plugin.id, "navigation.speedOverGround", "navigation.courseOverGroundTrue");
    const heading = new Delta(app, plugin.id,  "navigation.headingTrue");
    const mast = new Delta(app, plugin.id,  options.rotationPath);
    const attitude = new Delta(app, plugin.id, "navigation.attitude");

    apparentWind.subscribe( unsubscribes, "instant");
    apparentWind.speed.onChange = calculate; 
    boatSpeed.subscribe(unsubscribes, "instant");
    groundSpeed.subscribe( unsubscribes, "instant");
    heading.subscribe( unsubscribes, "instant");
    attitude.subscribe( unsubscribes, "instant");

    const calculatedWind = new PolarDelta(app, plugin.id, "environment.wind.speedApparent", "environment.wind.angleApparent");
    const trueWind = new PolarDelta(app, plugin.id, "environment.wind.speedTrue", "environment.wind.angleTrueWater");
    const groundWind = new PolarDelta(app, plugin.id, "environment.wind.speedOverGround", "environment.wind.directionTrue");
    const previousAttitude = new Delta(app, plugin.id, "navigation.attitude");

  }


  plugin.stop = () => {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
  };
  return plugin;
};
