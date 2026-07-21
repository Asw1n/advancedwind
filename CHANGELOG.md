# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [Unreleased]

### Fixed
- App Store icon was missing (monogram fallback shown): added `icon.png` at the package root so the App Store CDN can fetch it from the npm tarball via unpkg.com. The runtime `signalk.appIcon: ./icon.png` path is unchanged - the server still serves it from `public/icon.png` via the webapp mount.

## [2.8.1] - 2026-07-20

### Fixed
- Sidebar toggler was unreachable on mobile viewports.

### Changed
- Updated `signalkutilities` dependency to `^3.0.0` (removes `PolarTable` from the shared library; no behaviour change for this plugin).

## [2.8.0] - 2026-07-10

### Added
- Wind-shift output paths (`trend.fast`, `trend.slow`, `trend.shift`) are now throttled to a maximum of 1 Hz on the SK bus, even when incoming wind data arrives at a higher rate.
- `null` is written to all active output paths when the plugin stops, preventing stale values on the SK bus.
- `null` is written to the relevant output paths when `detectWindShift`, `backCalculateApparentWind`, or `calculateGroundWind` are toggled off.

## [2.7.1] - 2026-06-17

### Added
- Vector color legend: each vector in the inputs and outputs tables now shows a color swatch matching its line in the SVG diagram, making it easy to identify which value corresponds to which vector.
- Wind Shift scene: ground wind vector is now shown in the SVG alongside the fast and slow wind direction indicators.

### Fixed
- Height / 10 m correction now accounts for mast heel: the sensor's effective vertical height is reduced by roll and pitch before the wind gradient is applied, giving a more accurate 10 m normalisation when the boat is heeled. The heel vector is also shown in the Height scene when the correction is enabled.

### Changed
- Moving average smoother is now O(1) in both CPU and memory: it no longer slows down or uses more memory as the window size grows.
- Revised SVG vector color scheme: all vectors now have distinct, purposeful colors grouped by role — wind chain (amber → teal → blue → indigo), motion vectors (blue-grey), geometry vectors (earth tones), and wind shift indicators (cyan/steel/red). Line weights are also differentiated by group.
- Wind shift vectors (fast/slow) are drawn at a fixed length (45% of diagram height) rather than scaling with wind speed, making the direction comparison readable regardless of conditions.

## [2.7.0] - 2026-06-02

### Changed
- Upgraded `signalkutilities` dependency to v2.0.0. Signal K server now manages source priorities natively, delivering the highest-priority source for each path automatically.
- Config schema version bumped to 3.4. Existing installs are migrated automatically on first start.

### Removed
- Per-input source selectors. The Signal K server's built-in source priority ranking replaces this functionality. The source selection dropdowns have been removed from the webapp Inputs step.
- "Prevent duplication" option. Signal K's `excludeSelf: true` behaviour prevents the plugin's own output from feeding back as input, making this toggle unnecessary.
- All `source`, `passOn`, `sourceMagnitude`, `sourceAngle` arguments have been removed from internal `configure`, `createSmoothedHandler`, `createSmoothedPolar`, and `SmoothedAngle` calls in line with the v2 library API.

## [2.6.6] - 2026-05-18

### Fixed
- Source change deadlock: Bug that prevented old sources that no longer exist being cleared from the settings.

### Changed
- README: added "configured source not producing data" warning entry to the warnings table.

## [2.1.5] - 2025-1-30
### Fixed
- Bug that that caused mast angle not being read
- bug in order of corrections. Mast angle correction is noe done after all other mast related corrections

## [2.1.4] - 2025-1-2

### Fixed
- Bug that caused runtime errors in the pluginUtils file.[link test](https://github.com/Asw1n/advancedwind/issues/2).

## [2.1.3] - 2025-1-1

### Added
- Changelog to inform users of changes between versions
- Icon for the webapp

## [2.1.6] - 2025-1-1
### Fixed
- Bug in changing the configuration while the plugin is enabled

## [2.2.0] - 2025-8-30
### Removed 
- Leeway estimation. Tip: Get leeway from the Speed and Current plugin or the Derived Data plugin
### Added
- Oversampling and moving average for all input paths
- options to set sourced (name.id) for all input paths
- log warnings if input paths are not available or getting updates
### Fixed
- Better performance, less CPU
- Ground wind speed and direction are calculated
- Ground wind direction uses 0 to 2PI range instead of (-PI to PI)

## [2.5.0] - 2026-03-13
### Added
- New webapp that provides insight in every correction and calculation.
- runtime configuration of the plugin via the webapp including selectable data sources
- support for unitPreferences.
- configurable settings for data smoothing

### Removed
- Old webapp
- Standalone SVG view (`vectors.html`, `vectors.js`)
- Legacy API routes `/getResults` and `/getVectors`
- Standard signalk configuration via plugin.schema

### Fixed
- Double correction for leeway
- Processing data from other contexts than vessels.self and writing back to vessels.self

## [2.6.0] - 2026-03-22
### Added
- Windshift detection based on comparision between slow and fast moving wind trends
- Windshift presentation in webApp

## [2.6.3] - 2026-03-26

### Fixed
- Better handling of edge cases in the calculation pipeline
- bug regarding population of source selection list

## [2.6.5] - 2026-05-14

### Fixed
- Wind shift detection broken when staleness detection was enabled: `windShiftFast`/`windShiftSlow` were included in `applyStalenessDetection()`, which overwrote the fixed magnitude handler's intentional `stalenessDetection=false`, making it immediately stale and silencing the `onChange` callback

## [2.6.4] - 2026-05-14

### Added
- Optional staleness detection
- More precise warnings regarding the state of inputs


