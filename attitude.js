const {
  createSmoothedHandler,
  ExponentialSmoother,
  MovingAverageSmoother,
  KalmanSmoother,
  PassThroughSmoother
} = require('signalkutilities');

const ATTITUDE_SMOOTHER_KEYS = [
  'attitudeSmootherClass', 'attitudeSmootherTau',
  'attitudeSmootherTimeSpan', 'attitudeSmootherSteadyState'
];
const COMPONENTS = ['roll', 'pitch'];

function smootherSettings(options) {
  switch (options.attitudeSmootherClass) {
    case 'ExponentialSmoother':
      return { SmootherClass: ExponentialSmoother, smootherOptions: { tau: options.attitudeSmootherTau ?? 1 } };
    case 'PassThroughSmoother':
      return { SmootherClass: PassThroughSmoother, smootherOptions: {} };
    case 'KalmanSmoother':
      return { SmootherClass: KalmanSmoother, smootherOptions: { steadyState: options.attitudeSmootherSteadyState ?? 0.2 } };
    case 'MovingAverageSmoother':
      return { SmootherClass: MovingAverageSmoother, smootherOptions: { timeSpan: options.attitudeSmootherTimeSpan ?? 1 } };
    default:
      return { SmootherClass: KalmanSmoother, smootherOptions: { timeSpan: options.attitudeSmootherTimeSpan ?? 1 } };
  }
}

class AttitudeInput {
  constructor({ app, pluginId, options, onDelta, onIdle, onStale, onDisabled, onSourceChange }) {
    this.app = app;
    this.pluginId = pluginId;
    this.onDisabled = onDisabled;
    this.onDelta = onDelta;
    this.onIdle = onIdle;
    this.onStale = onStale;
    this.onSourceChange = onSourceChange;
    this.enabled = false;
    this.idle = new Set();
    this.sources = {};
    this.legacyTimes = {};
    const settings = {
      app,
      pluginId,
      subscribe: false,
      ...smootherSettings(options)
    };
    this.legacy = createSmoothedHandler({
      ...settings, id: 'attitude', path: 'navigation.attitude',
      onDelta: () => {
        if (this.configuring) return;
        const incoming = this.legacy.handler.value;
        for (const component of COMPONENTS) {
          if (incoming === null || incoming?.[component] === null) {
            delete this.legacyTimes[component];
          } else if (Number.isFinite(incoming?.[component])) {
            this.legacyTimes[component] = Date.now();
          }
        }
        if (this.idle.size) {
          this._updated(this.legacy, COMPONENTS.filter(component => Number.isFinite(incoming?.[component])));
        }
      },
      onIdle: () => { if (!this.ready) this.onIdle?.(); },
      onStale: () => { if (this.idle.size) this._unavailable(); }
    });
    // Construct all handlers before subscribing: cached values may arrive synchronously.
    this.components = Object.fromEntries(COMPONENTS.map(component => [
      component,
      createSmoothedHandler({
        ...settings, id: `attitude.${component}`, path: `navigation.attitude.${component}`,
        onDelta: () => {
          if (this.components[component].ready && Number.isFinite(this.components[component].value)) {
            this.idle.delete(component);
          }
          this._updated(this.components[component]);
          this._syncLegacy();
        },
        onIdle: () => {
          this.idle.add(component);
          this._syncLegacy();
          this._updated();
          if (!Number.isFinite(this.value[component])) this.onIdle?.();
        },
        onStale: () => this._unavailable()
      })
    ]));
    for (const handler of Object.values(this.components)) {
      handler.handler.onStale = () => {
        handler.invalidate();
        this._unavailable();
      };
    }
  }

  _selected(component) {
    const primary = this.components[component];
    if (this.enabled && primary.ready && primary.handler.ready && Number.isFinite(primary.value)) return primary;
    const last = this.legacyTimes[component];
    if (this.enabled && this.idle.has(component) && this.legacy.ready && this.legacy.handler.ready &&
        last !== undefined && Date.now() - last < this.legacy.handler.stalePeriod &&
        Number.isFinite(this.legacy.value?.[component])) return this.legacy;
    return null;
  }

  _updated(input = null, updatedComponents = COMPONENTS) {
    if (this.configuring) return;
    let changed = false;
    for (const component of COMPONENTS) {
      const path = this._selected(component)?.handler.path ?? null;
      if (this.sources[component] !== path) {
        changed = true;
        this.sources[component] = path;
        const source = path === this.path
          ? `legacy object ${path}`
          : path ? `individual path ${path}` : 'unavailable (waiting for fresh data)';
        this.app.debug(`[${this.pluginId}] attitude ${component} source: ${source}`);
      }
    }
    if (changed) this.onSourceChange?.();
    if (changed || (input && updatedComponents.some(component => this._selected(component) === input))) {
      this.onDelta?.();
    }
  }

  _unavailable() {
    this._updated();
    if (!this.ready) this.onStale?.();
  }

  _syncLegacy() {
    if (this.enabled && this.idle.size) {
      if (!this.legacy.subscribed) {
        this.legacyTimes = {};
        this.legacy.subscribe();
      }
    } else if (this.legacy.subscribed) {
      this.legacy.unsubscribe();
      this.legacyTimes = {};
    }
  }

  get value() {
    return Object.fromEntries(COMPONENTS.flatMap(component => {
      const selected = this._selected(component);
      return selected ? [[component, selected === this.legacy ? selected.value[component] : selected.value]] : [];
    }));
  }

  get ready() { return COMPONENTS.some(component => this._selected(component)); }
  get stale() {
    return this.enabled && !this.ready &&
      COMPONENTS.some(component => this.components[component].stale || this.components[component].handler.stale);
  }
  get path() { return 'navigation.attitude'; }
  get id() { return 'attitude.smoothed'; }
  get meta() {
    return {
      ...this.legacy.meta,
      components: Object.fromEntries(COMPONENTS.map(component => [component, this.components[component].meta]))
    };
  }
  get state() {
    const components = Object.fromEntries(COMPONENTS.map(component => {
      const selected = this._selected(component);
      return [component, {
        ...(selected ?? this.components[component]).state,
        ready: !!selected,
        selectedPath: selected?.handler.path ?? null,
        legacyFallback: selected === this.legacy,
        idle: this.idle.has(component)
      }];
    }));
    return {
      id: this.id, subscribed: this.enabled, ready: this.ready,
      isStale: this.stale, hasDelta: Object.values(components).some(state => state.hasDelta),
      components
    };
  }

  report() {
    const variance = {};
    for (const component of COMPONENTS) {
      const selected = this._selected(component);
      if (selected) variance[component] = selected === this.legacy ? selected.variance?.[component] : selected.variance;
    }
    return { id: this.id, path: this.path, value: this.value, variance, state: this.state };
  }

  configureSmoother(options) {
    const { SmootherClass, smootherOptions } = smootherSettings(options);
    this.configuring = true;
    try {
      for (const handler of [this.legacy, ...Object.values(this.components)]) {
        handler.setSmootherOptions(smootherOptions);
        handler.setSmootherClass(SmootherClass);
        // Retain fresh cached inputs when settings are applied during synchronous startup.
        if (handler !== this.legacy && handler.subscribed && handler.handler.ready) handler.sample();
      }
    } finally {
      this.configuring = false;
    }
  }

  syncSubscription(options) {
    const enabled = !!(options.correctForMastHeel || options.correctForMastMovement);
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.idle.clear();
    this.sources = {};
    this.legacyTimes = {};
    this.app.debug(enabled
      ? `[${this.pluginId}] attitude input enabled: preferring individual paths navigation.attitude.roll and navigation.attitude.pitch; waiting for fresh data`
      : `[${this.pluginId}] attitude input disabled`);
    for (const handler of Object.values(this.components)) {
      if (enabled) handler.subscribe();
      else handler.unsubscribe();
    }
    this._syncLegacy();
    if (!enabled) this.onDisabled?.();
  }

  terminate() {
    this.enabled = false;
    this.legacy.terminate();
    for (const handler of Object.values(this.components)) handler.terminate();
    return null;
  }
}

module.exports = { AttitudeInput, ATTITUDE_SMOOTHER_KEYS };
