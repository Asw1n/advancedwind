# Advanced Wind Insight webapp for SignalK

## Function and goal of the webapp
The Advanced Wind Insight webapp accompanies the Advanced Wind plugin. It provides real-time insight into every step of the wind calculation pipeline and also serves as the live configuration interface for the plugin — all corrections, parameters, data sources and smoother settings can be changed directly in the webapp while the plugin is running.

## Sidebar navigation
The webapp has a sidebar listing each stage of the calculation pipeline. Clicking a step shows the details for that stage:

- **Overview** — a summary vector diagram of the main inputs (apparent wind, boat speed, ground speed) and outputs (true wind, corrected apparent wind, ground wind).
- **Inputs** — all incoming Signal K paths with their current values, source selectors and smoother settings (smoother type and parameters).
- **Misalignment** — sensor misalignment correction.
- **Mast Rotation** — rotating mast correction.
- **Mast Heel** — mast heel (tilt) correction.
- **Mast Movement** — mast movement correction due to vessel rolling.
- **Upwash** — upwash angle correction.
- **Leeway** — leeway angle correction.
- **True Wind** — the true wind (wind over water) calculation step.
- **Height / 10 m** — wind gradient normalisation to a 10 m reference height.
- **Back Calc AW** — back-calculation of apparent wind from true wind.
- **Ground Wind** — wind over ground calculation.

## What each step shows
Each step page contains:
- A live **vector diagram** showing the wind and vessel vectors relevant to that step, coloured by type (apparent wind in orange, true wind in dark blue, ground wind in black, boat speed in light blue, ground speed in grey, corrected wind in green).
- **Settings** that are relevant to the step. Settings can be modified and modifications will take effect immediately. 
- A **data table** listing every input and output for the step with its current value, unit and a data-quality indicator showing whether the value is live, stale or missing.
- **Controls** to enable or disable the correction for that step and adjust its parameters. Changes take effect immediately without restarting the plugin.

