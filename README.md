# Advanced wind  Plugin for SignalK

## Function and goal of the plugin
The Advanced wind plugin is a plugin for SignalK server that calculates true wind from wind sensor data and paddle wheel data. It also calculates ground wind using GPS and compass data.

The goal of the plugin is to supply the best possible approximation of wind speed. To improve the wind speed calculation the plugin can make several corrections. Each individual correction is optional and most can be parameterised. The plugin can therefore be tuned to the boat's characteristics. The corrections will be discussed in more detail later on.

## Configuration
The plugin is configured through its own webapp — **Advanced Wind Insight** — accessible under Webapps in the SignalK dashboard. All corrections, parameters, data sources and smoother settings can be changed live while the plugin is running. The SignalK admin plugin settings page is intentionally left empty; use the webapp instead.

## About wind
Wind is the driving force of a sailing vessel. Therefore reliable wind information is important to all sailors. For performance sailors and racers this if even more true as reliable wind information allows them to compare the performance of their vessel to a maximum theoretical performance given in theis vessels polar data.
Wind has two important elements: speed and direction. Another important aspect is the frame of reference from which the wind is experienced. Wind seems stronger  on a moving vessel than on a anchored vessel. There are three commonly known frames of reference when dealing with wind. The first frame of reference is the vessel itself, this is the wind as it is perceived by a person on the vessel. This is commonly called the apparent wind. The second frame of reference is the wind as it would be perceived from an object floating on the water. This wind is called wind over water or true wind. The third frame of reference is the ground. This is the wind one would feel standing on a small island in the water. This is called wind over ground or ground wind. 
Each of these three winds are important to a sailor, although for different reasons:
- Apparent wind is important for trimming the sails. 
- True wind is important for determining when to tack or gibe. 
- Ground wind is important to predict the wind after the tide changes or to interprete weather forecasts.

The relation between the three different winds is as follows:
- Wind over water (true wind) = wind over ground + current
- Wind on the vessel (apparent wind) = Wind over water + vessel speed

These relations make it possible to convert one kind of wind to another. These conversions form the basis of the plugin.

There are in fact two other frames of reference that are relevant to the plugin. One is the mast as the mast moves in respect to the vessel on a rocking boat. The other is the wind sensor as the wind sensor can be misaligned in respect to the vessel.  

## The corrections and calculations
The plugin calculates the different winds going from one frame of reference to the other, starting with the wind measured by the sensor. In each frame of reference corrections might be applied. The order of calculations is to go from wind sensor to mast to vessel to water to ground. To distighish between the frames of reference we will uses sensor_wind, mast_wind, vessel_wind, water_wind and ground_wind when discussing the calculations and corrections.Furthermore, when we are talking specifically about wind speed ore wind angle we will use sensor_wind_speed or sensor_wind_angle etc.

### Going from sensor to mast, Sensor misalignment correction
To calculate the mast_wind from the sensor_wind the plugin substracts the sensor misalignment from the sensor_wind_angle. 
For this correction the plugin uses the plugin parameter sensorMisalignment that can be set in the webApp.

### Going from mast to vessel, Mast rotation correction
Some vessels have rotating masts, in this case the wind_angle has to be corrected for this rotation by substracting the mast rotation form the wind angle, vessel_wind_angle = mast_wind_angle - mast rotation.
SignalK does not have a defined path for mast rotation. The path to use has to be specified in the plugin setting.

### Going from mast to vessel, Mast heel correction
A wind sensor measures wind speed in a plane. When the mast is upright the sensor measures wind speed in a plane parallel to the surface of the earth. This is also how the wind blows, so the sensor measures all of the wind. When the boat and sensor are tilted then the plane in which the wind is measured is tilted too. The wind not only blows sideways on the sensor but also a bit from above or below. However, as the sensor is blind to the vertical part of the wind, it will only measure a portion of the wind. The wind speed will be underestimated. Knowing the tilt angle of the sensor the plugin can correct for this using the formula vessel_wind = mast_wind / cosine (mast angle).
For this correction the plugin uses the path vessel.attitude.

### Going from mast to vessel, Mast movement correction
As a vessel rolls due to wind and waves the wind sensor mounted in the mast moves in respect to the vessel. This movement adds to the windspeed a sensor experiences. To correct for this the plugin calculates this movement and substracts it from the mast_wind. 
The calculation of mast movement is based on the attitude change of the vessel and the height of the sensor in the mast.
For this the plugin uses the path vessel.attitude and plugin parameter sensorHeight.

### Going from mast to vessel, Upwash correction
The sails of a vessel do bend the wind, A phenomena that is called upwash. The wind angle measured by the wind sensor can to be corrected for this. The amount of upwash depends on the sailplan, on the position of the sensor and on the wind angle. Upwash can not be measured but it can be estimated. The plugin uses this formula to estimate upwash: Upwash Angle (°) =  (α ⋅ wind_angle(°) + β(°)) ⋅ max(0, cos(wind_angle)).
In this formula alpha and beta are parameters that can be set in the plugin options.


### Going from vessel to water, Leeway correction
The wind not only pushes a boat forward but also a bit sideways to leeward. This effect is called leeway. Most speed sensors only measure forward speed of the vessel and leeway is ignored. But to properly calculate water_wind leeway should be taken into account. 

The boat speed is ten corrected for leeway, boat_speed_angle  = boat_speed_angle + leeway.
This correction uses the path navigation.leewayAngle. (Leeway can be estimated by Derived Data plugin or by Speed and Current plugin).

### Going from vessel to water, boat speed correction
To calculate water_wind, commonly known as true wind, the plugin substracts vessel speed from the wind, water_wind = vessel_wind - boat_speed. 

### Going from vessel to water, mast height correction
Wind speed increases with height, an effect called wind gradient. to get wind speed that is comparable between vessels and with boat speed polar data the plugin normalises wind speed to a height of 10 meters, this being the value that is used both in polars and in weather forecasts. The wind gradient depends on factors like the smoothness of the water surface and the temperature difference between wind and water. The gradient is estimated using the formula: Wind gradient = (10 / sensor height above water)^α. Where alpha is a parameter that can be set in the plugin settings. The gradient is a factor that is applied to the wind speed using: water_wind_speed = water_wind_speed * gradient.

## Outputs

### True wind
The calculated water_wind (or true wind) is written to the paths environment.wind.speedTrue and environment.wind.angleTrueWater.

### Going from water to vessel, applying all corrections to the apparent wind
To apply the corrections to apparent wind too, it can optionally be back calculated from the true wind: vessel_wind = water_wind + vessel speed. The resulting apparent wind has all the corrections that are done when calculating true wind, except for the leeway correction.
The backcalculated apparent wind is written to the paths environment.wind.speedApparent and environment.wind.angleApparent. The result will be two diffent values the apparent wind paths, the back calculated one will have source set to AdvancedWind. To prevent having two values for apparent wird the plugin can optionally filter out the original wind data.

### Going from vessel to ground
Ground wind effectively is wind over water corrected for current. However current cannot be measured directly. Therefore, ground wind is calculated in a different way, using speed over ground and heading of the vessel: ground_wind = vessel_wind − ground_speed.
To calculate ground wind the plugin uses the paths navigation.speedOverGround, navigation.courseOverGroundTrue and navigation.headingTrue.
Ground wind is written to the paths environment.wind.speedOverGround and environment.wind.directionTrue.

### Wind shift detection
The plugin can optionally detect wind shifts based on ground wind direction. It does this by maintaining two moving averages of true wind direction: a fast one that tracks recent wind and a slow one that acts as a reference. The difference between them is the wind shift angle.

Three values are published to SignalK:
- `environment.wind.directionTrue.trend.fast` — fast moving average of true wind direction
- `environment.wind.directionTrue.trend.slow` — slow moving average of true wind direction (reference)
- `environment.wind.directionTrue.trend.shift` — wind shift angle (difference between fast and slow)

The smoothing method and smoother setings for the fast and slow averages are independently configurable in the webapp.

## Data smoothing
All inputs can be smoothed before being used in calculations. Four smoother types are available and can be selected in the webapp:
- **Kalman filter** — balances noise rejection and responsiveness dynamically. Tune with the *Kalman gain* (0 = ignore sensor completely, 1 = trust sensor fully).
- **Exponential smoother** — classic first-order low-pass filter. Tune with the time constant τ (seconds).
- **Moving average** — averages all samples within a configurable time window (seconds).
- **None (pass-through)** — no smoothing applied.

Attitude (heel/pitch) uses a separate smoother with its own type and parameter settings. Because attitude data is differentiated to compute the mast-tip velocity needed for the mast movement correction, a moving average is the recommended default.

## Inspecting the effect of calculations and corrections
The plugin comes with a webapp called **Advanced Wind Insight** that also serves as the live configuration interface. It is available under Webapps in the SignalK dashboard.

The webapp has a sidebar with a step for each stage of the calculation pipeline:
- **Overview** — a summary vector diagram showing the main inputs and outputs.
- **Inputs** — all incoming Signal K paths with their current values, source selectors and smoother settings.
- One step for each correction: **Misalignment**, **Mast Rotation**, **Mast Heel**, **Mast Movement**, **Upwash**, **Leeway**.
- **True Wind** — the true wind calculation step.
- **Height / 10 m** — wind gradient normalisation to a 10 m reference height.
- **Back Calc AW** — the back-calculated apparent wind.
- **Ground Wind** — the wind over ground calculation.
- **Wind Shift** — wind shift detection, showing fast and slow trend directions and the resulting shift angle.

Each step shows a live vector diagram of the relevant wind and vessel vectors, a table of input and output values with units and data-quality indicators, and controls to enable or disable the correction and adjust its parameters. Read more in the [webapp README](public/README.md).

## Some considerations
- Some wind sensors or instrument systems are able to apply heel correction or mast movement correction. In that case make sure that the same corrections is not made twice.
- Corrections increase the quality of the wind data. But they also can increase the noise level of the data, the fluctuations in corrected wind data might under some circumstances be bigger than in uncorrected data. Especially mast movement correction can make wind data noisy. 
- Good quality boat speed is essential for calculating wind over water. Take time to calibrate the paddle wheel or use the Speed and Current plugin to automatically correct boat speed.
- Good quality heading is essential for calculating wind over ground. Take time to calibrate the compass.
- Use the graph from the webapp to get an impression of the quality of your boat speed and heading data. Ground speed and boat speed should be the same when there is no current. The direction of ground wind should not change after tacking. If it does, this indicates poor calibration of the compass or misalignment of the wind sensor.










