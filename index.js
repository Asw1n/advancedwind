// bug in heel correction

module.exports = function (app) {


  const plugin = {};
  let unsubscribes = [];
  let lastCalculation = null;


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

  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      res.json(lastCalculation);
    });
    const options = app.readPluginOptions();
    app.debug(options);
  }


  plugin.start = (options) => {


    app.debug('Plugin started');


    const apparentWind = { speed: 0, angle: 0 };
    const currentAttitude = { roll: 0, pitch: 0, yaw: 0, timestamp: new Date() };
    const previousAttitude = { roll: 0, pitch: 0, yaw: 0, timestamp: new Date() };
    const boatSpeed = { speed: 0, angle: 0 };
    const groundSpeed = { speed: 0, angle: 0 };
    const mast = { speed: 0, angle: 0 };
    lastCalculation = initSteps();

    function toKnots(speed) {
      return 1.94384 * speed;
    }

    function toDegrees(angle) {
      return angle * 180 / Math.PI;
    }

    function toVector(obj) {
      if ('x' in obj) return obj;
      return { x: obj.speed * Math.cos(obj.angle), y: obj.speed * Math.sin(obj.angle) };
    }

    function toPolar(obj) {
      if ('speed' in obj) return obj;
      return { speed: Math.sqrt(obj.x * obj.x + obj.y * obj.y), angle: Math.atan2(obj.y, obj.x) };
    }

    function substract(speed1, speed2) {
      const a = toVector(speed1);
      const b = toVector(speed2);
      return {x: a.x -b.x, y: a.y - b.y};
    }

    function add(speed1, speed2) {
      const a = toVector(speed1);
      const b = toVector(speed2);
      return { x: a.x + b.x, y: a.y + b.y };
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

    function rotate1D(v, angle) {
      const p = toPolar(v);
      const newAngle = ((p.angle + angle + Math.PI) % (2 * Math.PI)) - Math.PI;
            return {speed: p.speed, angle: newAngle};
    }



    class ExponentialMovingAverage {
      constructor(timeConstant) {
        this.timeConstant = timeConstant * 1000; // Time constant (τ)
        this.ema = null; // Initial value
        this.lastTime = null; // Track the last update time
      }

      update(newValue, currentTime) {
        newValue = toVector(newValue);
        if (this.timeConstant == 0) return newValue;
        if (this.ema === null) {
          // Initialize EMA with the first value
          this.ema = newValue;
          this.lastTime = currentTime;
        }
        else {
          // Calculate the time difference
          const deltaTime = currentTime - this.lastTime;

          // Compute alpha
          const alpha = 1 - Math.exp(-deltaTime / this.timeConstant);

          // Update EMA
          this.ema.x = this.ema.x + alpha * (newValue.x - this.ema.x);
          this.ema.y = this.ema.y + alpha * (newValue.y - this.ema.y);

          // Update last time
          this.lastTime = currentTime;
        }
        return Object.assign({}, this.ema);
      }

    }

    const smoothTrue = new ExponentialMovingAverage(options.timeConstant);
    const smoothApparent = new ExponentialMovingAverage(options.timeConstant);
    const smoothGround = new ExponentialMovingAverage(options.timeConstant);



    let localSubscription = {
      context: "vessels.self",
      subscribe: [
        {
          path: "environment.wind.speedApparent",
          policy: "instant",
          //source: options.windInstrumentSource,
        },
        {
          path: "environment.wind.angleApparent",
          policy: "instant",
          //source: options.windInstrumentSource,
        },
        {
          path: "navigation.speedThroughWater",
          policy: "instant",
          //source: options.boatSpeedSource,
        }
      ]
    };
    if (options.correctForMastHeel || options.correctForMastMovement) {
      localSubscription.subscribe.push({
        path: "navigation.attitude",
        policy: "instant",
        //source: options.attitudeSource,
      });
    }
    if (options.correctForMastRotation && options.rotationPath !== undefined) {
      localSubscription.subscribe.push({
        path: options.rotationPath,
        policy: "instant",
        // source: options.boatSpeedSource,
      });
    }
    if (options.calculateGroundWind) {
      localSubscription.subscribe.push({
        path: "navigation.speedOverGround",
        policy: "instant",
        // source: options.boatSpeedSource,
      });
      localSubscription.subscribe.push({
        path: "navigation.courseOverGroundTrue",
        policy: "instant",
        // source: options.boatSpeedSource,
      });
      localSubscription.subscribe.push({
        path: "navigation.headingTrue",
        policy: "instant",
        // source: options.boatSpeedSource,
      });
    }

    // subscribe to deltas
    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          if (u.source?.label !== plugin.id) {

            u.values.forEach(v => {
              //app.debug(`${v.path} = ${v.value}`);
              switch (v.path) {
                case "environment.wind.speedApparent":
                  apparentWind.speed = v.value;
                  //app.debug(new Date(u.timestamp));
                  processDeltas(new Date(u.timestamp));
                  break;
                case "environment.wind.angleApparent":
                  apparentWind.angle = v.value;
                  break;
                case "navigation.attitude":
                  currentAttitude.pitch = v.value.pitch;
                  currentAttitude.roll = v.value.roll;
                  currentAttitude.timestamp = new Date(u.timestamp);
                  break;
                case "navigation.speedThroughWater":
                  boatSpeed.speed = v.value;
                  break;
                case "navigation.courseOverGroundTrue":
                  groundSpeed.angle = v.value;
                  break;
                case "navigation.speedOverGround":
                  groundSpeed.speed = v.value;
                  break;
                case "navigation.headingTrue":
                  currentAttitude.yaw = v.value;
                  break;
                default:
                  if (v.path == options.rotationPath) {
                    mast.angle = v.value;
                  }
                  else {
                    app.debug(`Unhandled subscription: ${v.path}`);
                  }
                  break;
              }
            });
          }

        });
      }
    );



    function processDeltas(timestamp) {
      // delta windspeed serves as a trigger for calculations;
      const calc = initSteps(timestamp);
      const values = [];
      wind = addWind(calc, "Measured wind speed", Object.assign({}, apparentWind));
      boat = addBoat(calc, "Measured boat speed", Object.assign({}, boatSpeed));
      ground = addBoat(calc, "Measured ground speed", Object.assign({}, groundSpeed));
      if (options.correctForMisalign)
        wind = addWind(calc, "correct for misalignment", rotate1D(wind, (options.sensorMisalignment * Math.PI / 180)));
      if (options.correctForMastRotation)
        wind = addWind(calc, "correct for mast rotation", rotate1D(wind, mast.angle));
      if (options.correctForUpwash)
        wind = addWind(calc, "correct for upwash", correctForUpwash(wind));
      if (options.correctForMastHeel)
        wind = addWind(calc, "correct for mast heel", correctForMastHeel(wind, currentAttitude));
      if (options.correctForMastMovement)
        wind = addWind(calc, "correct for mast movement", correctForMastMovement(wind, addAtt(calc, "Rotation (m/s)", calculateRotation(addAtt(calc, "Attitude (°)", currentAttitude, "rad"), previousAttitude), "m/s")));
      if (options.correctForLeeway)
        boat = addBoat(calc, "correct for leeway", addLeeway(boat, wind, currentAttitude));
      trueWind = addWind(calc, "calculate true wind", substract(wind, boat));
      if (options.correctForHeight)
        trueWind = addWind(calc, "normalise to 10 meters", normaliseToTen(trueWind));
      appWind = addWind(calc, "back calculate apparent wind", add(trueWind, boat));
      if (options.calculateGroundWind)
        groundWind = addWind(calc, "calculate ground wind", substract(rotate1D(appWind, currentAttitude.yaw), addBoat(calc, "speed over ground", groundSpeed)));
      sendTrueWind(values, addWind(calc, "dampen true wind", smoothTrue.update(trueWind, timestamp)));
      if (options.backCalculate)
        sendApparentWind(values, addWind(calc, "dampen apparent wind", smoothApparent.update(appWind, timestamp)));
      if (options.calculateGroundWind)
        sendGroundWind(values, addWind(calc, "dampen ground wind", smoothGround.update(groundWind, timestamp)));
      sendDeltas(values);
      Object.assign(previousAttitude, currentAttitude);
      Object.assign(lastCalculation, calc);
    }

    // correct for wind upwash due to the sails close to the wind sensor
    function correctForUpwash(wind) {
      wind = toPolar(wind);
      const upwash = options.upwashSlope * wind.angle + options.upwashOffset * Math.PI / 180;
      return rotate1D(wind, -upwash);
    }

    // correct for the attitude of the boat and wind sensor
    function correctForMastHeel(wind, attitude) {
      //return rotate2D(toVector(wind), getRotationMatrix(attitude));
      wind = toVector(wind);
      wind.x = wind.x / Math.cos(attitude.pitch);
      wind.y = wind.y / Math.cos(attitude.roll);
      return wind;
    }

    // correct for rolling and pitching of the boat 
    function correctForMastMovement(wind, rotation) {
      wind = toVector(wind);
      const r = options.heightAboveWater;
      const sensorSpeed = { x: rotation.pitch * r, y: rotation.roll * r };
      return add(wind, sensorSpeed);
    }

    // normalise windspeed to a height of 10 metres above water
    function normaliseToTen(wind) {
      wind = toVector(wind);
      const factor = Math.pow((10 / options.heightAboveWater), options.windExponent);
      wind.x *= factor;
      wind.y *= factor;
      return wind;
    }

    // calculate leeway and add to boat speed
    function addLeeway(boat, wind, attitude) {
      boat = toPolar(boat);
      wind = toPolar(wind);
      boat.angle = options.leewaySpeed * (boat.speed / wind.speed) + options.leewayAngle * Math.sin(attitude.roll);
      return boat;
    }

    function sendLeeway(values, boatSpeed) {
      boatSpeed= toPolar(boatSpeed);
      values.push({ path: 'environment.wind.directionTruenavigation.leewayAngle', value: boatSpeed.angle });
    }

    function sendTrueWind(values, trueWind) {
      trueWind = toPolar(trueWind);
      values.push({ path: 'environment.wind.angleTrueWater', value: trueWind.angle });
      values.push({ path: 'environment.wind.speedTrue', value: trueWind.speed });
    }

    function sendApparentWind(values, appWind) {
      appWind = toPolar(appWind);
      values.push({ path: 'environment.wind.angleApparent', value: appWind.angle });
      values.push({ path: 'environment.wind.speedApparent', value: appWind.speed });
    }

    function sendGroundWind(values, wind) {
      wind=toPolar(wind);
      values.push({ path: 'environment.wind.directionTrue', value: wind.angle });
      values.push({ path: 'environment.wind.speedOverGround', value: wind.speed });
    }

    function sendDeltas(values) {
      const delta = {
        context: 'vessels.self',
        updates: [
          {
            source: {
              label: plugin.id
            },
            values: values
          }]
      };
      app.handleMessage(plugin.id, delta);
    }

    function initSteps(timestamp) {
      return {
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

    function addWind(calculations, label, speed) {
      speed = toPolar(speed);
      calculations.windSteps.push(
        {
          label: label,
          speed: toKnots(speed.speed),
          angle: toDegrees(speed.angle)
        }
      );
      return speed;
    }

    function addBoat(calculations, label, speed) {
      speed = toPolar(speed);
      calculations.boatSteps.push(
        {
          label: label,
          speed: toKnots(speed.speed),
          angle: toDegrees(speed.angle)
        }
      );
      return speed;
    }

    function addAtt(calculations, label, att, unit) {
      if (unit == 'rad') {
        roll = toDegrees(att.roll);
        pitch = toDegrees(att.pitch);
        yaw = toDegrees(att.yaw);
      }
      else {
        roll = att.roll;
        pitch = att.pitch;
        yaw = att.yaw;
      }
      calculations.attitudeSteps.push(
        {
          label: label,
          roll: roll,
          pitch: pitch,
          yaw: yaw
        }
      );
      return att;
    }

  }


  plugin.stop = () => {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
  };
  return plugin;
};
