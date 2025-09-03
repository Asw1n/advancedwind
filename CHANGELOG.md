# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

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

## [2.4.0] - ntb
### Added
- Effect of each individual correction is shown in the webapp
- Visual indication of missing or stale inputs in the webapp
### Fixed
- Bug in removing duplicate apparent wind speed when writing back-calculated apparent wind speed
