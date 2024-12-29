# Advanced wind  Plugin for SignalK

## Function and goal of the plugin
The Advanced wind plugin is a plugin for SignalK server that calculates true wind from wind sensor data  and peddle wheel data. It also calculates ground wind using wind sensor data using GPS and compass data.

The goal of the plugin is to supply the best possible approximation of wind speed. To improve the wind speed calculation the plugin can make several corrections. Each individual correction is optional and most can be parameterised. The plugin can therefore be tuned to the boats characteristics. The corrections will be discussed in more detail later on.

## About wind
Wind is the driving force of a sailing vessel. Therefore reliable wind information is important to all sailors. For performance sailors and racers this if even more true as reliable wind information allows them to compare the performance of their vessel to a maximum theoretical performance given in theis vessels polar data.
Wind has to important elements, wind speed and wind direction. There is only one wind, but depending on once reference it will be perceived differently. Wind seems stronger when on a vessel moving to the wind than when to boat is anchored. There are three important frames of reference when dealing with wind on a vessel. The first frame of reference is the vessel itself, this is the wind as it is perceived by a person on the vessel and it is called the apparent wind.
The second frame of reference is the wind as it would be perceived when on an object floating on the water. This wind is called true wind. The third frame of reference is the ground. This is the wind one would feel standing on a small island in the water. This is also the wind that wheather forecasts use. 
Each of these three winds are important to a sailor, although for different reasons. Apparent wind is important for sail trimming, true wind is important for determining when to tack or gibe, and ground wind is important to predict the wind after the tide changes or to inerprete whaether forecasts.
The relation between the three different winds is as follows:
- Wind over water (true wind) = wind over ground + current
- Wind on the vessel (apparent wind) = Wind over water + vessel speed
These relations make it possible to calculate one kind of wind from another. These calculations form the basis of the plugin.

There is in fact a fourth and a fifth kind of wind that are often overlooked but important to the corrections this plugin makes. This is the wind as it is experienced by the wind sensor high up in the mast. As the mast is moved by wind and waves the sensor has a speed of its own in addition to the speed of the boat (we will call the mast wind). Then the sensor might be misaligned in the mast, and the sensor will experience a different wind angle then the mast or the sailor on deck. When we are precise then apparent speed really has the sensor as a reference and not the vessel. This is how the plugin treats apparent wind.

## The corrections and calculations
The plugin calculates the different winds going from one frame of reference to the other, starting with the wind measured by the sensor. In each frame of reference some corrections can be applied. The order of calculations is to go from wind sensor to mast to vessel to water to ground. 
To distighish between the frames of reference we will uses sensor_wind, mast_wind, vessel_wind, water_wind ang ground_wind when discussing the calculations and corrections.
Furthermore, when we are talking specifically about wind speed ore wind angle we will use sensor_wind_speed or sensor_wind_angle etc.

### Going from sensor to mast, Sensor misalignment correction
To calculate the mast_wind from the sensor_wind the plugin substracts the sensor misalignment from the sensor_wind_angle. mast_wind_angle = senso_wind_angle - sensor_misalignment.
Fro this correction the plugin uses the plugin parameter sensorMisalignment that can be set in the plugin options.

### Going from mast to vessel, Mast heel correction
A wind sensor measures wind speed in a plane and not in three directions. When the mast is upright the sensor measures wind speed in a plane parallel to the surface of the earth. This is how the wind blows (normally). When the boat is tilted also the plane in which the wind is measured is tilted. For the sensor it is as if the wind is not only going sideways, but that a part of the wind is vertical. Only the sensor is blind to the vertical part of the wind, It will therefore only measure a portion of the wind.
When the angle or the sensor in respect to the earth plane is known the plugin can correct for this using the formula vessel_wind = mast_wind / cosine (mast angle).
For this correction the plugin uses the path vessel.attitude.

### Going from mast to vessel, Mast movement correction
As a vessel rolls due to wind and waves tha mast and the sensor mounted to the mast move in respect to the vessel. This movement adds to the windspeed a sensor experiences. To correct for this the speed and direction of this movement is calculated and substracted from the mast_wind. 
The calculation of mast movement is based on the attitude change of the mast and the height of the sensor in the mast.
For this the plugin uses the path vessel.attitude and plugin parameter sensorHeight.

### Going from mast to vessel, Mast rotation correction
Some vessels have rotating masts, as a result the wind_angle has to be corrected for this rotation by substracting the mast rotation form the wind angle, vessel_wind_angle = mast_wind_angle - mast rotation.
SignalK does not have a defined path for mast rotation. The path to use has to be specified in the plugin setting.

### Going from mast to vessel, Upwash correction
The sails of a vessel do bend the wind, A phenomena that is called upwash. The wind angle measured by the wind sensor can to be corrected for this. The amount of upwash depends on the sailplan, on the position of the sensor and on the wind angle. It can normally not be measured but it can be estimated. The plugin uses this formula to estimate upwash: Upwash Angle (°) =  (α ⋅ wind_angle(°) + β(°)) ⋅ max(0, cos(wind_angle)).
In this formula alpha and beta are parameters that can be set in the plugin options.
![Alt text](upwash.png)

### Going from vessel to water, Leeway correction
The wind not only pushes a boat forward but also a bit sideways to leward. This effect is called leeway. Most speed sensors only measure forward speed of the vessel and leeway is ignored. But to properly calculate water_wind leeway should be taken into account. Leeway depends on hull shape, vessel speed and heel. The plugin uses this formula to estimate leeway angle: Leeway angle (°) = k ⋅ heel / speed ^ 2.
The boat speed is then corrected for leeway, boat_speed_angle = leeway.
The k factor can be specified in the plugin settings.
If leeway correction is applied, the leeway anlge willbe written to the path environment.wind.directionTruenavigation.leewayAngle.

### Going from vessel to water, boat speed correction
To calculate water_wind, commonly known as true wind, the plugin substracts vessel speed from the wind, water_wind = vessel_wind - boat_speed. 


### Going from vessel to water, mast height correction
Wind speed increases with height, an effect called wind gradient. to get wind speed that is is comparrable between vessels or with polars the plugin normalises wind speed to a height of 10 meters, the value that is used in polars and in forecasts. The wind gradient depends on factors like the smoothnes of the water surface and temperature difference between wind and water. The gradient is estimated using the formula: Wind gradient = (10 / sensor height above water)^α. Where alpha is a parameter that can be set in the plugin settings. The gradient is a factor that is applied to the wind speed using: water_wind_speed = water_wind_speed * gradient.

The resulting wind speed is a corrected and normalised wind over water. It is written to the paths environment.wind.speedTrue and environment.wind.angleTrueWater.

### Going from water to vessel, applying all corrections to the apparent wind
The apparent wind that the wind sensor measures does not contain all the corrections the plugin made. To apply the corrections to apparent wind too, it is back calculated from the true wind: vessel_wind = water_wind + vessel speed. The resulting apparent wind hs all the corrections that are done when calculating true wind, except from the leeway correction.
The apparent wind as the wind sensor provides is filtered out by the plugin. Instead it will provide the corrected apparent wind in the paths environment.wind.speedApparent and environment.wind.angleApparent.

### Going from vessel to ground
Ground wind effectively is wind over water corrected for current. However is current can not be measured directly ground wind is calculated in different way using speed over ground. Ground_wind = vessel_wind - ground speed. Ground speed then has to be further corrected for the vessel direction by substracting the heading from the ground speed angle.
To calculate ground speed the plugin uses the paths "nvironment.wind.speedOverGround,  environment.wind.directionTrue and navigation.headingTrue.
Ground speed is written to the paths navigation.speedOverGround and navigation.courseOverGroundTrue.

### Smoothing wind data
The plugin works best on raw wind data. This can fluctuate quite a bit. Therefore the plugin can smoothen the output to make it appear more stable and thus easier to read. For smoothing the plugin uses an exponential moving average which gives exponentially more weight to more recent data. The amount of smoothing can be set by specifying a time constant in the plugin settings. A time constant of 0 will result in no smoothing at all.
If smoothing is applied, only the smoothened values will be written to before mentioned paths.

## Inspection the effect of calculations and corrections
The plugin comes with a webapp for Signalk that shows  a graph of all the speed and wind vectors in play and a breakdown of every individual calculation in real time. This way one can easily see what is going on. Read more about the webapps in [link test](public/README.md).

## Some considerations
- Use unfiltered inputs as much as possible. Especially smooothing or damping should be disabled or be as low as possible. It is better to apply smoothing after corrections are made.
- Some wind sensors or instrument systems are able to apply heel correction or mast movement correction. In that case make sure that the same corrections is made twice.
- Corrections increase the quality of the wind data. But they also increase the noise level of the data, the fluciations you see might be bigger.
- Good quality boat speed is essential for calculating wind over water. Take time to calibrate the paddle wheel.
- Good quality heading is essential for calculating wind over ground. Take time to calibrate the compass.
- Use the graph from the webapp to get an impression of the quality of your boat speed and heading data. Ground speed and boat speed should be the same when there is no current. The direction of ground wind does not change after tacking when the compass is calibrated well and the wind sensor is aligned.










