# Advanced Wind — SignalK Plugin

Advanced Wind is a SignalK server plugin that calculates true wind, back-calculated apparent wind, and ground wind from your boat's sensor data. Beyond a basic true-wind calculation it applies a chain of optional, individually tunable corrections that improve the quality of the result. The built-in webapp lets you inspect each step of the calculation live and change every setting while the plugin is running.

---

## Why use this plugin instead of Derived Data?

The **Derived Data** plugin (and similar alternatives) also calculate true wind and ground wind from apparent wind and boat speed. That is sufficient for many purposes. Advanced Wind goes further in two ways:

1. **Corrections.** Real wind sensors on real boats introduce several systematic errors that a plain trigonometric conversion ignores. Advanced Wind can correct for each of them, individually and with tunable parameters.
2. **Transparency.** The webapp shows the full calculation pipeline step by step with live vector diagrams, so you can see exactly what each correction does to the data on your own boat.

If you only need a quick true-wind number and your instruments are well-calibrated, Derived Data is fine. If you notice that your true wind direction jumps after a tack, that your wind speed seems low in a seaway, or that you want to compare against polar data with confidence, the corrections this plugin provides are worth configuring.

---

## Installation

Install through the SignalK app store or by running `npm install advancedwind` in the SignalK data directory, then restart SignalK and enable the plugin. The SignalK admin settings page for the plugin is intentionally empty — all configuration is done through the webapp.

---

## The webapp — Advanced Wind Insight

Open the webapp from **Webapps → Advanced Wind** in the SignalK dashboard. It serves as both the live display and the configuration interface. You do not need to restart the plugin after changing settings; changes take effect immediately.

The left-hand sidebar lists every step of the calculation pipeline. Clicking a step shows:

- A **vector diagram** of the wind and vessel vectors relevant to that step.
- A **data table** showing the input and output values with units and data-quality indicators.
- A **Warnings** section that lists any inputs that are missing or not usable, and any required parameters that have not been set.
- An enable/disable toggle and parameter controls where applicable.

The steps, in calculation order, are:

| Step | What it shows |
|---|---|
| Overview | Summary diagram: apparent wind in, true wind out, ground wind (if enabled) |
| Inputs | All incoming Signal K paths, their current values, source selectors and smoother settings |
| Misalignment | Sensor mounting angle correction |
| Mast Rotation | Rotating mast correction |
| Mast Heel | Wind speed underestimation when the boat heels |
| Mast Movement | Sensor velocity added by the rocking mast |
| Upwash | Sail-induced wind angle distortion |
| Leeway | Sideways hull drift correction |
| True Wind | The true wind (water wind) calculation |
| Height / 10 m | Wind gradient normalisation to 10 m reference height |
| Back Calc AW | Apparent wind recalculated from corrected true wind |
| Ground Wind | Wind over ground calculation |
| Wind Shift | Fast and slow trend directions and the resulting shift angle |

---

## The corrections

All corrections are disabled by default. Enable only those that apply to your boat and that you can supply the required data for.

### Sensor misalignment
The wind vane and wind sensor are rarely mounted perfectly in line with the boat's centreline. This correction subtracts a fixed offset angle from the sensor reading. Set the misalignment angle in the webapp.

### Mast rotation
On boats with a rotating mast (mainly catamarans and some racing dinghies), the mast angle relative to the hull changes the measured wind angle. The plugin requires a Signal K path that provides the mast rotation angle. Because there is no standard path for this, you must specify the path in the plugin settings. This correction has no effect if your mast does not rotate.

### Mast heel
A wind sensor mounted at the top of a mast measures wind in the plane of the sensor. When the boat heels, that plane tilts away from horizontal and the sensor sees only the cosine component of the wind speed — it underestimates. The correction divides the measured speed by the cosine of the heel angle using `navigation.attitude`. The effect is small at modest heel angles (about 1.5 % at 10°) but grows quickly (about 6 % at 20°, 13 % at 30°).

### Mast movement
When the boat rolls and pitches in a seaway, the mast tip — and the sensor — moves through the air. This motion adds to the apparent wind the sensor experiences. The correction calculates the velocity of the mast tip from the attitude rate of change and the configured sensor height, then subtracts it from the measured wind. This correction can make the wind data noisier because it amplifies attitude noise, so consider the tradeoff on your boat.

> **Note:** All corrections are optional. Some instrument systems apply heel and/or mast movement corrections internally before sending data to Signal K. Check your instrument documentation to avoid applying the same correction twice.

### Upwash
The sails bend the airflow, so the wind angle at the sensor is not the same as the undisturbed wind angle. The plugin estimates this using the formula:

$$\text{upwash} = (\alpha \cdot \text{wind angle} + \beta) \cdot \max(0, \cos(\text{wind angle}))$$

The parameters α (slope) and β (offset) can be set in the webapp. The defaults (slope 0.05, offset 1.5°) are a reasonable starting point for a typical fractional sloop, but the correct values depend on your rig. Upwash only affects close-hauled sailing; it goes to zero on a run.

### Leeway
Most paddlewheel and impeller speed sensors measure speed through the water in the fore-aft direction only. Leeway — the sideways slipping of the hull to leeward — is ignored. This means the boat's actual velocity through the water is slightly different from what is reported. The correction adds the leeway angle to the boat speed vector before subtracting it from the apparent wind. The plugin reads `navigation.leewayAngle`. The Derived Data plugin can supply this path using a model calculation based on heel angle and boat speed. The Speed and Current plugin derives leeway from long-term observation of the difference between heading and course over ground, which is more accurate but takes time to converge.

### Height / wind gradient normalisation to 10 m
Wind speed increases with height above the water surface. Polar data and weather forecasts standardise on 10 m height. The correction scales the calculated true wind speed to a 10 m reference height using a power-law wind gradient:

$$\text{speed}_{10\,\text{m}} = \text{speed}_{\text{sensor}} \times \left(\frac{10}{\text{height above water}}\right)^{\alpha}$$

The default exponent α = 0.14 is appropriate for open water with neutral atmospheric stability. The configured sensor height above the waterline is also used for the mast movement correction.

---

## Outputs

| Signal K path | Content |
|---|---|
| `environment.wind.speedTrue` | True wind speed (water wind) |
| `environment.wind.angleTrueWater` | True wind angle (water wind) |
| `environment.wind.speedApparent` | Back-calculated apparent wind speed (if enabled) |
| `environment.wind.angleApparent` | Back-calculated apparent wind angle (if enabled) |
| `environment.wind.speedOverGround` | Ground wind speed (if enabled) |
| `environment.wind.directionTrue` | Ground wind direction (if enabled) |
| `environment.wind.directionTrue.trend.fast` | Fast moving average of ground wind direction (wind shift) |
| `environment.wind.directionTrue.trend.slow` | Slow moving average (reference) |
| `environment.wind.directionTrue.trend.shift` | Wind shift angle: difference between fast and slow averages |

### Back-calculated apparent wind
When this option is enabled the plugin recalculates apparent wind from the corrected true wind and boat speed. This propagates all the corrections back to the apparent wind path. The "Prevent duplication" option (enabled by default) suppresses the original apparent wind delta so downstream consumers only see one value for `environment.wind.angleApparent` — the corrected one.

### Ground wind
Ground wind is calculated from vessel wind minus speed over ground (using `navigation.speedOverGround` and `navigation.courseOverGroundTrue`). It requires a calibrated compass (`navigation.headingTrue`) as well. Ground wind is useful for interpreting weather forecasts and for predicting what the wind will do after a tide change.

### Wind shift detection
The wind shift step maintains two moving averages of the ground wind direction: a fast one that tracks recent wind and a slow one that acts as a reference. The difference between them is published as the shift angle. Smoothing types and time constants for both averages can be set independently in the webapp.

---

## Warnings in the webapp

Each step in the webapp shows a **Warnings** section whenever something prevents it from working correctly. The warnings and their meaning:

| Warning | Meaning | What to do |
|---|---|---|
| *"[path] — not subscribed to Signal K"* | The plugin tried to subscribe to a path but Signal K rejected the subscription. | Check that the path string is correctly typed in the Sources section of the Inputs step. |
| *"[path] — path not found in Signal K"* | The path is valid but no device on your network produces this data. | Verify that the instrument producing this data is connected and recognised by SignalK. For optional corrections this simply means the correction cannot be used. |
| *"[path] — configured source not producing data"* | A specific source is selected for this input but no data is arriving from it. This typically means the instrument was replaced or renamed and an old source name is still configured. | Open the Sources section of the Inputs step and clear the source selector for this input to accept data from any source. You can then select the new source from the dropdown once data is flowing. |
| *"[path] — waiting for first data"* | The plugin is subscribed but has not received any data yet. | Wait a few seconds after startup. If it persists, check that the instrument is active and sending data. |
| *"[path] — data is stale"* | Data was arriving but has stopped updating. | Check the connection to the instrument. Stale detection can be disabled per-path in the Inputs step if the instrument sends infrequent but valid updates. |
| *"[parameter] is not set"* | A correction is enabled but a required parameter has no value. | Open the settings for that step and enter the missing value. |
| *"[path] — no data"* | No state information is available at all for this input. | Usually a transient condition at startup; if it persists restart the plugin. |

A step that has active warnings still runs if it can, but the result may be incorrect or the correction may be silently skipped. Resolve warnings before relying on the output for performance analysis.

---

## Data smoothing

The primary purpose of smoothing is to handle sensors that update at different rates. Wind sensors, GPS, and attitude sensors typically run at different frequencies. By smoothing each input independently you effectively oversample the faster inputs and bring all values to a common, consistent time base.

Smoothing also reduces sensor noise at the cost of some responsiveness. The smoother type and parameters are set in the Inputs step. The available smoothers are:

| Smoother | Best for | Parameter |
|---|---|---|
| **Kalman filter** | General use — balances noise and responsiveness automatically | Gain: 0 = ignore sensor, 1 = trust sensor fully |
| **Exponential (EMA)** | Classic low-pass filtering | Time constant τ in seconds |
| **Moving average** | Averaging over a fixed time window | Window size in seconds |
| **None** | When the instrument already filters its output | — |

Attitude data (heel/pitch) uses a separate smoother and defaults to a moving average. This is intentional: attitude is differentiated to compute mast tip velocity for the mast movement correction, and a moving average avoids amplifying the high-frequency noise that differentiation would exaggerate with other smoother types.

---

## Calibration tips

- **Boat speed** is the most important input for true wind quality. A poorly calibrated paddlewheel causes the true wind direction to change after tacking even when the real wind has not. Use the Speed and Current plugin to automate boat speed calibration against GPS SOG in still water.
- **Compass heading** is the most important input for ground wind quality. A compass error or misalignment shows up as a false wind shift when you tack. Check that your deviation table is current and that the compass is not near magnetic interference.
- **Wind sensor misalignment** is easy to check on a windless morning in flat water with the engine. Motor directly into the wind and set the misalignment offset so that the apparent wind angle reads zero.
- Use the **Overview** and **Ground Wind** steps in the webapp after a tack. If the ground wind direction stays constant your calibration is good. If it jumps, focus on compass heading and sensor misalignment first.
- Corrections increase accuracy on average but can increase noise under some conditions. The mast movement correction in particular amplifies attitude sensor noise at high sea states. If corrected wind is noisier than raw wind, increase the attitude smoother time constant or disable the mast movement correction.

---

## Source selection

For each input the Inputs step shows a source selector. This matters when multiple instruments supply the same path (for example two GPS receivers). Select the source you trust most. The plugin will use only data from that source and ignore data from others for that path.

---

## Frequently asked questions

**Why is the admin settings page empty?**  
All configuration is in the webapp. The admin page cannot represent the live, interdependent configuration the plugin uses, so it is intentionally left blank. Open **Webapps → Advanced Wind** instead.

**The webapp shows a warning about apparent wind path — is that normal?**  
If you have enabled "Back-calculate apparent wind" and "Prevent duplication", the plugin suppresses the incoming apparent wind delta. The warning that the apparent wind path shows as stale or not-arriving in *other* plugins is expected in that case — the original signal is being filtered by design.

**Can I run Advanced Wind alongside Derived Data?**  
Yes. Both plugins write to the same standard Signal K paths, which is correct — in Signal K a path can have multiple sources. Configure your displays to read from the source named `AdvancedWind` to ensure they show the corrected values.

**Does the plugin work without any corrections enabled?**  
Yes. With all corrections disabled it performs a standard true-wind vector calculation identical to what Derived Data does, plus optionally ground wind. You can then enable corrections one at a time and observe the effect in the webapp.
