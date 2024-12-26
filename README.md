# Advanced wind  Plugin for SignalK

This SignalK plugin calculates true wind and ground wind. Optionally the plugin also corrects for:
- Sensor misalignment
- Mast rotation 
- Vessel heel 
- Mast movements
- Upwash
- Leeway
- Sensor heigth

The plugin comes with a webapp that allows you to inspect the effect of the various corrections in real time. I suck at crating nice looking html pages, if you want to help me improve this, please do!

SignalK paths needed:
- environment.wind.speedApparent
- environment.wind.angleApparent
- mast rotation path as specified in the options, only for mast rotation
- navigation.attitude, only for correction for vessel heel and pitch and correction for mast movement
- navigation.speedThroughWater
- navigation.speedoverground, only for calculating ground speed
- navigation.courseOverGroundTrue, only for calculating ground speed
- navigation.headingTrue, only for calculating ground speed

The plugin uses appoximations when applying corrections. The following approximations are used:

- Leeway angle (°) = k ⋅ heel / speed ^ 2
- Upwash Angle (°) = α ⋅ AWA(°) + β(°)
- Wind gradient = (10 / sensor height above water)^α

For each of this formulas α and β are parameters that can be specified in the plugin config.

