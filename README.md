# Advanced wind  Plugin for SignalK

This SignalK plugin calculates true wind and, optionally, also ground wind, back-calculated apparent wind and leeway. Optionally the plugin also corrects for:
- Sensor misalignment
- Mast rotation 
- Vessel heel 
- Mast movements
- Upwash
- Leeway
- Sensor heigth

The plugin comes with an app that allows you to inspect the effect of the corrections in real time.

SignalK paths needed:
- environment.wind.speedApparent
- environment.wind.angleApparent
- mast rotation path as specified in the options, only for mast rotation
- navigation.attitude, only for correction for vessel heel and pitch and correction for mast movement
- navigation.speedThroughWater, only when not using speed over ground for boat speed
- navigation.speedoverground, only when using speed over ground for boat speed or when outputting ground speed
- navigation/courseOverGroundTrue, only when outputting ground speed

The plugin uses appoximations when applying corrections. The following approximations are used:

- Leeway angle (°) = α ⋅ Vboat / Vwind + β ⋅ sin(Heel Angle)
- Upwash Angle (°) = α ⋅ AWA(°) + β(°)
- Wind gradient = (10 / sensor height above water)^

For each of this formulas α and β are parameters that can be specified in the plugin config.



