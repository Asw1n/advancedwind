'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pluginFactory = require('../index.js');

function withRoutePolicies(router) {
  if (router.routePolicies instanceof Map) return router;

  const policies = new Map();
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const originalMethods = new Map();
  for (const method of methods) {
    if (typeof router[method] !== 'function') continue;
    const original = router[method];
    originalMethods.set(method, original);
    router[method] = (route, ...handlers) => {
      policies.set(`${method.toUpperCase()} ${route}`, 'admin');
      return original.call(router, route, ...handlers);
    };
  }

  router.access = (level) => {
    if (level !== 'readonly' && level !== 'readwrite') {
      throw new Error(`Unsupported route access level: ${level}`);
    }
    const scopedRouter = {};
    for (const [method, original] of originalMethods) {
      scopedRouter[method] = (route, ...handlers) => {
        policies.set(`${method.toUpperCase()} ${route}`, level);
        return original.call(router, route, ...handlers);
      };
    }
    return scopedRouter;
  };
  router.routePolicies = policies;
  return router;
}

function createTestPlugin(app) {
  const plugin = pluginFactory(app);
  const registerWithRouter = plugin.registerWithRouter;
  plugin.registerWithRouter = (router) => registerWithRouter(withRoutePolicies(router));
  return plugin;
}

// ---------------------------------------------------------------------------
// App shim helpers
// ---------------------------------------------------------------------------

/**
 * Minimal BaconJS-style reactive-stream bus mock.
 * Every chaining method returns `this`; onValue returns an unsubscribe no-op.
 * This satisfies the internal stream API used by signalkutilities.
 */
function createMockBus() {
  const bus = {};
  const chainMethods = [
    'onError', 'onEnd', 'skipDuplicates', 'map', 'filter', 'take', 'first',
    'toPromise', 'flatMap', 'flatMapLatest', 'merge', 'debounce',
    'debounceImmediate', 'throttle', 'delay', 'bufferWithTime', 'bufferWithCount',
    'combine', 'sampledBy', 'scan', 'fold', 'zip', 'awaiting', 'not', 'log',
    'doAction', 'doLog', 'doError', 'doEnd', 'withHandler', 'name',
    'withDescription', 'skip', 'slidingWindow', 'startWith', 'mapEnd',
    'skipWhile', 'takeWhile', 'takeUntil', 'errors', 'mapError', 'subscribe',
  ];
  for (const m of chainMethods) bus[m] = () => bus;
  bus.onValue = (_cb) => () => {};
  bus.push = () => {};
  bus.plug = () => () => {};
  bus.end = () => {};
  return bus;
}

/**
 * Create a minimal SignalK app shim that satisfies the advancedwind plugin.
 * A Proxy is used so that any method not explicitly stubbed returns a no-op
 * instead of throwing a TypeError.
 *
 * @returns {{ app: object, cleanup: () => void }}
 */
function createAppShim() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advancedwind-test-'));
  const configFile = path.join(tmpDir, 'AdvancedWind.json');

  const base = {
    // Logging
    debug: () => {},
    error: () => {},

    // Plugin status
    setPluginStatus: () => {},
    setPluginError: () => {},

    // Delta output
    handleMessage: () => {},

    // Data access
    getSelfPath: () => undefined,
    getPath: () => undefined,
    getMetadata: () => undefined,
    putSelfPath: (_p, _v, cb) => { if (cb) cb({ state: 'COMPLETED' }); },
    putPath: (_p, _v, cb) => { if (cb) cb({ state: 'COMPLETED' }); },

    // Plugin config persistence
    readPluginOptions: () => {
      try { return JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch { return {}; }
    },
    savePluginOptions: (config, cb) => {
      fs.writeFileSync(configFile, JSON.stringify(config));
      if (cb) cb();
    },
    getPluginOptions: () => ({}),
    getDataDirPath: () => path.join(tmpDir, 'data'),

    // Subscription infrastructure
    registerDeltaInputHandler: () => () => {},
    registerPutHandler: () => () => {},

    streambundle: {
      getSelfBus: () => createMockBus(),
      getBus: () => createMockBus(),
      getSelfStream: () => createMockBus(),
      getAvailablePaths: () => [],
    },

    subscriptionmanager: {
      subscribe: (_msg, unsubscribes, _errorCb, _deltaCb) => {
        const unsub = () => {};
        if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
      },
    },

    // Event emitter API
    on: () => {},
    once: () => {},
    emit: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},

    // Server identity
    selfId: 'urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000',
    selfType: 'vessels',
    selfContext: 'vessels.urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000',

    config: {
      configPath: tmpDir,
      appPath: tmpDir,
      version: '2.35.0',
      name: 'signalk-server',
      basePath: '/signalk/v1',
      defaults: {},
    },

    reportOutputMessages: () => {},

    wrappedEmitter: {
      bindMethodsById: () => ({ on: () => {}, removeListener: () => {} }),
    },
  };

  // Proxy: any property not found in base returns a no-op function so unstubbed
  // accesses from signalkutilities don't throw.
  const app = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('module export', () => {
  it('exports a factory function', () => {
    const factory = require('../index.js');
    assert.strictEqual(typeof factory, 'function', 'module.exports must be a function');
  });
});

describe('plugin object shape', () => {
  let plugin;
  let cleanup;

  before(() => {
    const shim = createAppShim();
    cleanup = shim.cleanup;
    plugin = createTestPlugin(shim.app);
  });

  after(() => cleanup());

  it('has a non-empty string id', () => {
    assert.strictEqual(typeof plugin.id, 'string');
    assert.ok(plugin.id.length > 0, 'plugin.id must not be empty');
  });

  it('has a non-empty string name', () => {
    assert.strictEqual(typeof plugin.name, 'string');
    assert.ok(plugin.name.length > 0, 'plugin.name must not be empty');
  });

  it('has a string description', () => {
    assert.strictEqual(typeof plugin.description, 'string');
  });

  it('exposes a valid JSON Schema object', () => {
    assert.strictEqual(typeof plugin.schema, 'object', 'plugin.schema must be an object');
    assert.ok(plugin.schema !== null);
    assert.strictEqual(plugin.schema.type, 'object', 'schema.type must be "object"');
    assert.strictEqual(typeof plugin.schema.properties, 'object', 'schema.properties must be an object');
  });

  it('has start and stop functions', () => {
    assert.strictEqual(typeof plugin.start, 'function', 'plugin.start must be a function');
    assert.strictEqual(typeof plugin.stop, 'function', 'plugin.stop must be a function');
  });
});

describe('registerWithRouter', () => {
  it('registers the expected GET and PUT routes', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      const registered = [];
      const mockRouter = {
        get: (p) => registered.push(`GET ${p}`),
        put: (p) => registered.push(`PUT ${p}`),
      };
      plugin.registerWithRouter(mockRouter);

      assert.ok(registered.includes('GET /meta'), 'missing GET /meta');
      assert.ok(registered.includes('GET /report'), 'missing GET /report');
      assert.ok(registered.includes('GET /settings'), 'missing GET /settings');
      assert.ok(registered.includes('PUT /settings'), 'missing PUT /settings');
    } finally {
      cleanup();
    }
  });

  it('applies readonly access only to the approved report routes', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      const router = { get: () => {}, put: () => {} };
      plugin.registerWithRouter(router);

      assert.deepStrictEqual(Object.fromEntries(router.routePolicies), {
        'GET /meta': 'readonly',
        'GET /state': 'readonly',
        'GET /report': 'readonly',
        'GET /settings': 'admin',
        'PUT /settings': 'admin',
        'GET /sources': 'readonly',
      });
    } finally {
      cleanup();
    }
  });

  it('GET /settings returns current options with _bounds', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      const routes = {};
      const mockRouter = {
        get: (p, handler) => { routes[`GET ${p}`] = handler; },
        put: (p, handler) => { routes[`PUT ${p}`] = handler; },
      };
      plugin.registerWithRouter(mockRouter);

      let response = null;
      const req = {};
      const res = { json: (data) => { response = data; } };
      routes['GET /settings'](req, res);

      assert.ok(response !== null, 'GET /settings returned no response');
      assert.strictEqual(typeof response._bounds, 'object', 'response must include _bounds');
      assert.strictEqual(typeof response.smootherClass, 'string', 'response must include smootherClass');
    } finally {
      cleanup();
    }
  });

  it('PUT /settings clamps out-of-range numeric values', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      const routes = {};
      const mockRouter = {
        get: (p, handler) => { routes[`GET ${p}`] = handler; },
        put: (p, handler) => { routes[`PUT ${p}`] = handler; },
      };
      plugin.registerWithRouter(mockRouter);

      let response = null;
      // heightAboveWater bounds: min 0, max 50
      const req = { body: { heightAboveWater: 999 } };
      const res = { json: (data) => { response = data; } };
      routes['PUT /settings'](req, res);

      assert.ok(response !== null, 'PUT /settings returned no response');
      assert.ok(
        response.heightAboveWater <= 50,
        `heightAboveWater should be clamped to ≤50, got ${response.heightAboveWater}`
      );
    } finally {
      cleanup();
    }
  });
});

describe('configuration migration', () => {
  function createMigrationShim(pluginOptions) {
    const { app: base, cleanup } = createAppShim();
    let savedOptions = null;
    const app = new Proxy(base, {
      get(target, prop) {
        if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
        if (prop === 'savePluginOptions') return (config, cb) => {
          savedOptions = config;
          if (cb) cb();
        };
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return () => {};
      },
    });
    return { app, cleanup, getSavedOptions: () => savedOptions };
  }

  it('normalizes nested legacy settings once and preserves the result on restart', () => {
    const shim = createMigrationShim({ configuration: { sensorMisalignment: 90 } });
    try {
      const plugin = createTestPlugin(shim.app);
      plugin.registerWithRouter({ get: () => {}, put: () => {} });
      const first = shim.getSavedOptions();

      assert.strictEqual(first.version, '3.4');
      assert.strictEqual(first.sensorMisalignment, Math.PI / 2);
      assert.strictEqual(first.backCalculateApparentWind, true);

      const secondShim = createMigrationShim(first);
      try {
        const secondPlugin = createTestPlugin(secondShim.app);
        secondPlugin.registerWithRouter({ get: () => {}, put: () => {} });
        assert.strictEqual(secondShim.getSavedOptions(), null, 'current settings should not be migrated again');
      } finally {
        secondShim.cleanup();
      }
    } finally {
      shim.cleanup();
    }
  });

  it('recovers malformed and unsupported configurations with current defaults', () => {
    for (const invalid of [null, { version: '9.9' }]) {
      const shim = createMigrationShim(invalid);
      try {
        const plugin = createTestPlugin(shim.app);
        assert.doesNotThrow(() => plugin.registerWithRouter({ get: () => {}, put: () => {} }));
        const saved = shim.getSavedOptions();
        assert.strictEqual(saved.version, '3.4');
        assert.strictEqual(saved.backCalculateApparentWind, true);
      } finally {
        shim.cleanup();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Memory-leak / feedback-loop detection
//
// Hypothesis (Issue #22): when backCalculateApparentWind is true the plugin
// writes to environment.wind.speedApparent / environment.wind.angleApparent —
// the same paths it reads from via the apparentWind PolarSmoother.
// Signal K's excludeSelf:true subscription option is supposed to break this
// loop.  If that option is not honoured (e.g. SK < v2.28), the plugin drives
// a runaway feedback loop.
//
// Strategy: build a "feedback shim" whose subscriptionmanager delivers the
// plugin's own handleMessage output back to every registered subscriber for
// those paths (simulating broken excludeSelf).  Feedback is capped at
// MAX_FEEDBACK_DELIVERIES to keep the test bounded in time and memory.
// A healthy system produces O(1) handleMessage calls per seed delta;
// a runaway loop saturates the cap.
// ---------------------------------------------------------------------------

/** Maximum feedback deliveries before the shim stops routing output back. */
const MAX_FEEDBACK_DELIVERIES = 30;

/**
 * Creates an app shim + a subscriber registry so tests can inject deltas.
 * handleMessage does NOT echo back — this is the normal (no-feedback) case.
 * Returns { app, cleanup, subscribers, messageCount }.
 */
function createTrackingShim(pluginOptions = {}) {
  const { app: base, cleanup } = createAppShim();
  const subscribers = new Map();
  const messageCount = { value: 0 };

  const app = new Proxy(base, {
    get(target, prop) {
      if (prop === 'subscriptionmanager') {
        return {
          subscribe(msg, unsubscribes, _err, deltaCb) {
            for (const s of (msg.subscribe || [])) {
              if (!subscribers.has(s.path)) subscribers.set(s.path, new Set());
              subscribers.get(s.path).add(deltaCb);
            }
            const unsub = () => {
              for (const s of (msg.subscribe || [])) subscribers.get(s.path)?.delete(deltaCb);
            };
            if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
          },
        };
      }
      if (prop === 'handleMessage') return () => { messageCount.value++; };
      if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  return { app, cleanup, subscribers, messageCount };
}

/**
 * Creates an app shim that echoes plugin output back to subscribers, up to
 * MAX_FEEDBACK_DELIVERIES times.  This simulates a Signal K version that does
 * not honour excludeSelf:true.
 * Returns { app, cleanup, subscribers, messageCount, heapSamples }.
 */
function createFeedbackShim(pluginOptions = {}) {
  const { app: base, cleanup } = createAppShim();
  const subscribers = new Map();
  const messageCount = { value: 0 };
  const heapSamples = [];
  let feedbackDeliveries = 0;

  const app = new Proxy(base, {
    get(target, prop) {
      if (prop === 'subscriptionmanager') {
        return {
          subscribe(msg, unsubscribes, _err, deltaCb) {
            for (const s of (msg.subscribe || [])) {
              if (!subscribers.has(s.path)) subscribers.set(s.path, new Set());
              subscribers.get(s.path).add(deltaCb);
            }
            const unsub = () => {
              for (const s of (msg.subscribe || [])) subscribers.get(s.path)?.delete(deltaCb);
            };
            if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
          },
        };
      }

      if (prop === 'handleMessage') {
        return (_pluginId, delta) => {
          messageCount.value++;
          heapSamples.push(process.memoryUsage().heapUsed);
          // Echo back to subscribers (broken excludeSelf), but only up to the cap
          // to prevent the exponential queue from growing without bound.
          if (feedbackDeliveries < MAX_FEEDBACK_DELIVERIES) {
            feedbackDeliveries++;
            setImmediate(() => {
              for (const update of (delta?.updates ?? [])) {
                for (const entry of (update?.values ?? [])) {
                  const cbs = subscribers.get(entry.path);
                  if (cbs) for (const cb of [...cbs]) cb(delta);
                }
              }
            });
          }
        };
      }

      if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  return { app, cleanup, subscribers, messageCount, heapSamples };
}

/**
 * Yield to the event loop `ticks` times so queued setImmediate callbacks run.
 */
async function drainTicks(ticks) {
  for (let i = 0; i < ticks; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/**
 * Push a delta to all registered subscribers for the paths in `values`.
 */
function deliverDelta(subscribers, values, source = 'nmea2000') {
  const delta = { updates: [{ $source: source, values }] };
  for (const entry of values) {
    const cbs = subscribers.get(entry.path);
    if (cbs) for (const cb of [...cbs]) cb(delta);
  }
}

/**
 * Creates an app shim + subscriber registry that also records every delta
 * passed to handleMessage, for assertions on published values.
 * Returns { app, cleanup, subscribers, sentDeltas }.
 */
function createCapturingShim(pluginOptions = {}) {
  const { app: base, cleanup } = createAppShim();
  const subscribers = new Map();
  const sentDeltas = [];

  const app = new Proxy(base, {
    get(target, prop) {
      if (prop === 'subscriptionmanager') {
        return {
          subscribe(msg, unsubscribes, _err, deltaCb) {
            for (const s of (msg.subscribe || [])) {
              if (!subscribers.has(s.path)) subscribers.set(s.path, new Set());
              subscribers.get(s.path).add(deltaCb);
            }
            const unsub = () => {
              for (const s of (msg.subscribe || [])) subscribers.get(s.path)?.delete(deltaCb);
            };
            if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
          },
        };
      }
      if (prop === 'handleMessage') return (_pluginId, delta) => { sentDeltas.push(delta); };
      if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  return { app, cleanup, subscribers, sentDeltas };
}

describe('wind shift lifecycle', () => {
  it('invalidates the computed shift when detection is disabled', async () => {
    const { app, cleanup, subscribers } = createCapturingShim({
      detectWindShift: true,
      windShiftFastClass: 'PassThroughSmoother',
      windShiftSlowClass: 'PassThroughSmoother',
    });

    try {
      const plugin = createTestPlugin(app);
      const routes = {};
      plugin.registerWithRouter({
        get: (path, handler) => { routes[`GET ${path}`] = handler; },
        put: (path, handler) => { routes[`PUT ${path}`] = handler; },
      });
      plugin.start();

      deliverDelta(subscribers, [
        { path: 'environment.wind.directionTrue', value: 0.5 },
      ]);
      deliverDelta(subscribers, [
        { path: 'environment.wind.directionTrue', value: 0.6 },
      ]);

      let report;
      routes['GET /report']({}, { json: data => { report = data; } });
      assert.strictEqual(report.deltas.windShift.state.ready, true);
      assert.strictEqual(report.deltas.windShiftFast.state.handler.subscribed, true);
      assert.strictEqual(report.deltas.windShiftSlow.state.handler.subscribed, true);

      routes['PUT /settings'](
        { body: { detectWindShift: false } },
        { json: () => {} }
      );
      routes['GET /report']({}, { json: data => { report = data; } });

      assert.strictEqual(report.deltas.windShift.state.ready, false);
      assert.strictEqual(report.deltas.windShift.state.hasDelta, false);
      assert.strictEqual(report.deltas.windShiftFast.state.handler.subscribed, false);
      assert.strictEqual(report.deltas.windShiftSlow.state.handler.subscribed, false);

      routes['PUT /settings'](
        { body: { detectWindShift: true } },
        { json: () => {} }
      );
      routes['GET /report']({}, { json: data => { report = data; } });
      assert.strictEqual(report.deltas.windShiftFast.state.handler.subscribed, true);
      assert.strictEqual(report.deltas.windShiftSlow.state.handler.subscribed, true);
      assert.strictEqual(report.deltas.windShiftFast.state.ready, false);
      assert.strictEqual(report.deltas.windShiftSlow.state.ready, false);

      deliverDelta(subscribers, [
        { path: 'environment.wind.directionTrue', value: 0.7 },
      ]);
      deliverDelta(subscribers, [
        { path: 'environment.wind.directionTrue', value: 0.8 },
      ]);
      routes['GET /report']({}, { json: data => { report = data; } });
      assert.strictEqual(report.deltas.windShiftFast.state.ready, true);
      assert.strictEqual(report.deltas.windShiftSlow.state.ready, true);
      assert.strictEqual(report.deltas.windShift.state.ready, true);

      await plugin.stop();
    } finally {
      cleanup();
    }
  });
});

describe('memory leak / feedback loop detection (Issue #22)', () => {
  it('handleMessage call count stays bounded without feedback (sanity check)', async () => {
    // No feedback shim — handleMessage is a no-op counter.
    // One seed apparent-wind delta should fire calculate() once → one handleMessage.
    const { app, cleanup, subscribers, messageCount } = createTrackingShim({
      backCalculateApparentWind: true,
    });

    try {
      const plugin = createTestPlugin(app);
      plugin.start();

      deliverDelta(subscribers, [
        { path: 'environment.wind.speedApparent', value: 5.0 },
        { path: 'environment.wind.angleApparent', value: 0.5 },
      ]);

      await drainTicks(20);

      assert.ok(
        messageCount.value <= 10,
        `Expected ≤10 handleMessage calls without feedback, got ${messageCount.value}`
      );

      await plugin.stop();
    } finally {
      cleanup();
    }
  });

  it('detects runaway feedback loop when excludeSelf is not enforced', async () => {
    // Feedback shim echoes plugin output back as input (up to MAX_FEEDBACK_DELIVERIES).
    // With backCalculateApparentWind:true the plugin writes the paths it reads from,
    // so any feedback causes repeated calculate() → handleMessage() → feedback cycles.
    //
    // EXPECTED RESULT before fix:  messageCount.value >> 1 (saturates the cap)
    // EXPECTED RESULT after fix:   messageCount.value <= 2
    //
    // To verify the fix is working, change the final assertion from `> 2` to `<= 2`.
    const { app, cleanup, subscribers, messageCount, heapSamples } = createFeedbackShim({
      backCalculateApparentWind: true,
    });

    try {
      const plugin = createTestPlugin(app);
      plugin.start();

      // Seed: one NMEA apparent-wind delta.
      deliverDelta(subscribers, [
        { path: 'environment.wind.speedApparent', value: 5.0 },
        { path: 'environment.wind.angleApparent', value: 0.5 },
      ]);

      // Drain enough ticks for all capped feedback rounds to complete.
      await drainTicks(MAX_FEEDBACK_DELIVERIES + 10);

      await plugin.stop();

      const total = messageCount.value;
      console.log(`[feedback test] handleMessage calls (cap=${MAX_FEEDBACK_DELIVERIES}): ${total}`);
      if (heapSamples.length >= 2) {
        const growthKB = (heapSamples[heapSamples.length - 1] - heapSamples[0]) / 1024;
        console.log(`[feedback test] heap change over ${heapSamples.length} handleMessage calls: ${growthKB.toFixed(1)} KB`);
      }

      // This assertion currently documents the BUG (feedback loop exists).
      // Flip to `<= 2` once excludeSelf is verified or a guard is re-added.
      assert.ok(
        total > 2,
        `Expected feedback loop (handleMessage > 2 times) but got ${total}. ` +
        'If this fails, either the loop is not triggered or the fix is already active.'
      );
    } finally {
      cleanup();
    }
  });

  it('heap growth rate stays below 1 MB/sec during normal 1-Hz operation', async () => {
    // No feedback — simulate ~3 Hz NMEA2000 apparent-wind input for ~2 seconds.
    // Confirms there is no baseline memory leak at the stated NMEA data rate.
    const { app, cleanup, subscribers } = createTrackingShim({
      backCalculateApparentWind: true,
    });

    try {
      const plugin = createTestPlugin(app);
      plugin.start();

      if (typeof global.gc === 'function') global.gc(); // optional, needs --expose-gc
      const heapBefore = process.memoryUsage().heapUsed;
      const start = Date.now();
      const DURATION_MS = 2000;
      const INTERVAL_MS = 333; // ~3 Hz

      while (Date.now() - start < DURATION_MS) {
        deliverDelta(subscribers, [
          { path: 'environment.wind.speedApparent', value: 5.0 + Math.random() * 0.1 },
          { path: 'environment.wind.angleApparent', value: 0.5 + Math.random() * 0.01 },
        ]);
        await drainTicks(2);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
      }

      if (typeof global.gc === 'function') global.gc();
      const heapAfter = process.memoryUsage().heapUsed;
      const durationSec = (Date.now() - start) / 1000;
      const growthMBPerSec = (heapAfter - heapBefore) / 1e6 / durationSec;
      console.log(`[1-Hz leak test] heap growth: ${growthMBPerSec.toFixed(3)} MB/sec over ${durationSec.toFixed(1)}s`);

      assert.ok(
        growthMBPerSec < 1.0,
        `Heap growth ${growthMBPerSec.toFixed(3)} MB/sec exceeds 1 MB/sec threshold`
      );

      await plugin.stop();
    } finally {
      cleanup();
    }
  });
});

describe('plugin lifecycle', () => {
  it('start() completes without throwing', async () => {
    const { app, cleanup } = createAppShim();
    let plugin;
    try {
      plugin = createTestPlugin(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw');
    } finally {
      if (plugin) {
        await assert.doesNotReject(
          () => plugin.stop(),
          'plugin.stop() must resolve without rejection'
        );
      }
      cleanup();
    }
  });

  it('stop() resolves cleanly after start()', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      plugin.start();
      await assert.doesNotReject(
        () => plugin.stop(),
        'plugin.stop() must resolve without rejection'
      );
    } finally {
      cleanup();
    }
  });

  it('can be restarted (start → stop → start → stop)', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = createTestPlugin(app);
      plugin.start();
      await plugin.stop();
      assert.doesNotThrow(() => plugin.start(), 'second start() must not throw');
      await assert.doesNotReject(() => plugin.stop(), 'second stop() must resolve');
    } finally {
      cleanup();
    }
  });
});

describe('attitude guard clauses (missing spec sub-property)', () => {
  it('mast heel correction skips only the missing axis instead of producing NaN', async () => {
    const { app, cleanup, subscribers, sentDeltas } = createCapturingShim({
      correctForMastHeel: true,
      backCalculateApparentWind: true,
    });
    let plugin;
    try {
      plugin = createTestPlugin(app);
      plugin.start();

      // Attitude delta missing pitch — only roll is present.
      deliverDelta(subscribers, [{ path: 'navigation.attitude', value: { roll: 0.1 } }]);
      deliverDelta(subscribers, [
        { path: 'environment.wind.speedApparent', value: 5.0 },
        { path: 'environment.wind.angleApparent', value: 0.5 },
      ]);
      await drainTicks(5);

      const values = sentDeltas.flatMap(d => (d?.updates ?? []).flatMap(u => u?.values ?? []));
      assert.ok(values.length > 0, 'expected at least one published value');
      for (const v of values) {
        if (typeof v.value === 'number') {
          assert.ok(Number.isFinite(v.value), `${v.path} should stay finite when attitude.pitch is missing`);
        }
      }
    } finally {
      if (plugin) await plugin.stop();
      cleanup();
    }
  });
});

describe('initialization order (subscription race)', () => {
  /**
   * Some subscriptions can deliver a value synchronously during subscribe() itself
   * when the server already has a cached value for the path.
   * This shim reproduces that by invoking deltaCb immediately
   * for environment.wind.speedApparent/angleApparent, which drives apparentWind's
   * onDelta (and therefore calculate()) before plugin.start() has returned.
   */
  function createSyncBootstrapShim(pluginOptions = {}, extraBootstrap = {}) {
    const { app: base, cleanup } = createAppShim();
    const subscribers = new Map();
    const bootstrapValues = {
      'environment.wind.speedApparent': 4.0,
      'environment.wind.angleApparent': 0.3,
      ...extraBootstrap,
    };

    const app = new Proxy(base, {
      get(target, prop) {
        if (prop === 'subscriptionmanager') {
          return {
            subscribe(msg, unsubscribes, _err, deltaCb) {
              for (const s of (msg.subscribe || [])) {
                if (!subscribers.has(s.path)) subscribers.set(s.path, new Set());
                subscribers.get(s.path).add(deltaCb);
                if (Object.prototype.hasOwnProperty.call(bootstrapValues, s.path)) {
                  deltaCb({ updates: [{ $source: 'boot', values: [{ path: s.path, value: bootstrapValues[s.path] }] }] });
                }
              }
              const unsub = () => {
                for (const s of (msg.subscribe || [])) subscribers.get(s.path)?.delete(deltaCb);
              };
              if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
            },
          };
        }
        if (prop === 'handleMessage') return () => {};
        if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return () => {};
      },
    });

    return { app, cleanup, subscribers };
  }

  it('does not throw when apparentWind delivers synchronously during subscribe (start-time race)', () => {
    const { app, cleanup } = createSyncBootstrapShim({ backCalculateApparentWind: true });
    let plugin;
    try {
      plugin = createTestPlugin(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw on a synchronous bootstrap delta');
    } finally {
      if (plugin) plugin.stop?.();
      cleanup();
    }
  });

  const cachedAttitude = { 'navigation.attitude': { roll: 0.1, pitch: 0.02, yaw: 1.0 } };

  function captureRoutes(plugin) {
    const routes = { get: {}, put: {} };
    plugin.registerWithRouter({
      get: (p, cb) => { routes.get[p] = cb; },
      put: (p, cb) => { routes.put[p] = cb; },
    });
    const call = (method, p, body) => {
      let payload;
      routes[method][p]({ body, query: {} }, { json: v => { payload = v; }, status: () => ({ json: v => { payload = v; } }) });
      return payload;
    };
    return {
      settings: () => call('get', '/settings'),
      putSettings: body => call('put', '/settings', body),
      report: () => call('get', '/report'),
    };
  }

  it('does not throw when attitude delivers synchronously during subscribe with mast heel correction enabled', async () => {
    const { app, cleanup } = createSyncBootstrapShim({ correctForMastHeel: true }, cachedAttitude);
    let plugin;
    try {
      plugin = createTestPlugin(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw on a synchronous attitude delta');
      await plugin.stop();
      assert.doesNotThrow(() => plugin.start(), 'restart must not throw on a synchronous attitude delta');
    } finally {
      if (plugin) await plugin.stop();
      cleanup();
    }
  });

  it('seeds the derivative from a synchronous attitude with mast movement correction enabled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { app, cleanup, subscribers } = createSyncBootstrapShim({
      correctForMastMovement: true,
      heightAboveWater: 10,
    }, cachedAttitude);
    let plugin;
    try {
      plugin = createTestPlugin(app);
      const api = captureRoutes(plugin);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw on a synchronous attitude delta');
      assert.equal(api.report().polars.sensorSpeed.state.ready, false, 'one sample must not produce a sensor speed');

      t.mock.timers.tick(100);
      deliverDelta(subscribers, [{ path: 'navigation.attitude', value: { roll: 0.2, pitch: 0.02, yaw: 1.0 } }]);

      const report = api.report();
      const smoothed = report.attitudes['attitude.smoothed'].value;
      const sensorSpeed = report.polars.sensorSpeed;
      // The cached sample (roll 0.1, pitch 0.02) seeds the derivative: rate * height over 0.1 s.
      const expectedY = ((smoothed.roll - 0.1) / 0.1) * 10;
      const expectedX = ((smoothed.pitch - 0.02) / 0.1) * 10;
      assert.equal(sensorSpeed.state.ready, true, 'second sample must produce a sensor speed');
      assert.ok(expectedY > 0, 'smoothed roll should move towards the new sample');
      assert.ok(Math.abs(sensorSpeed.y - expectedY) < 1e-9, `expected y = ${expectedY}, got ${sensorSpeed.y}`);
      assert.ok(Math.abs(sensorSpeed.x - expectedX) < 1e-9, `expected x = ${expectedX}, got ${sensorSpeed.x}`);
    } finally {
      if (plugin) await plugin.stop();
      cleanup();
    }
  });

  it('applies pending attitude smoother settings on a synchronous attitude at startup', async () => {
    const { app, cleanup } = createSyncBootstrapShim({ correctForMastHeel: true }, cachedAttitude);
    let plugin;
    try {
      plugin = createTestPlugin(app);
      const api = captureRoutes(plugin);
      // Changed while stopped: stays pending until the plugin runs.
      api.putSettings({ attitudeSmootherClass: 'ExponentialSmoother', attitudeSmootherTau: 2 });
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw with pending attitude smoother settings');
      const settings = api.settings();
      assert.equal(settings.attitudeSmootherClass, 'ExponentialSmoother');
      assert.equal(settings.attitudeSmootherTau, 2);
    } finally {
      if (plugin) await plugin.stop();
      cleanup();
    }
  });

  it('applies pending smoother settings when cached wind and attitude arrive synchronously on restart', async () => {
    const { app, cleanup } = createSyncBootstrapShim(
      { correctForMastHeel: true, correctForMastMovement: true },
      cachedAttitude,
    );
    let plugin;
    try {
      plugin = createTestPlugin(app);
      const api = captureRoutes(plugin);
      plugin.start();
      await plugin.stop();
      api.putSettings({ smootherTau: 1, attitudeSmootherTimeSpan: 2 });
      assert.doesNotThrow(() => plugin.start(), 'restart must not throw with pending smoother settings');
      const settings = api.settings();
      assert.equal(settings.smootherTau, 1);
      assert.equal(settings.attitudeSmootherTimeSpan, 2);
      assert.equal(api.report().attitudes['attitude.smoothed'].state.ready, true);
    } finally {
      if (plugin) await plugin.stop();
      cleanup();
    }
  });
});

describe('input silence without recovery resubscriptions', () => {
  it('keeps subscriptions attached, reports silence and accepts resumed wind', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { app, cleanup } = createAppShim();
    const subscribers = new Map();
    let subscriptions = 0;
    let unsubscriptions = 0;
    let messages = 0;
    app.readPluginOptions = () => ({ configuration: {
      detectWindShift: true, correctForLeeway: true, rotationPath: 'sensors.mast.rotation',
      windShiftFastTau: 1, windShiftSlowTau: 1
    } });
    app.handleMessage = () => { messages++; };
    app.subscriptionmanager.subscribe = (msg, unsubscribes, _err, callback) => {
      subscriptions++;
      for (const { path } of msg.subscribe) {
        if (!subscribers.has(path)) subscribers.set(path, new Set());
        subscribers.get(path).add(callback);
      }
      unsubscribes.push(() => {
        unsubscriptions++;
        for (const { path } of msg.subscribe) subscribers.get(path).delete(callback);
      });
    };
    const plugin = createTestPlugin(app);
    try {
      const routes = {};
      plugin.registerWithRouter({
        get: (p, cb) => { routes[p] = cb; }, put: () => {}
      });
      plugin.start();
      deliverDelta(subscribers, [
        { path: 'environment.wind.speedApparent', value: 5 },
        { path: 'environment.wind.angleApparent', value: 0.4 }
      ]);
      const initialSubscriptions = subscriptions;
      const initialMessages = messages;
      t.mock.timers.tick(120000);
      assert.equal(subscriptions, initialSubscriptions);
      assert.equal(unsubscriptions, 0);
      assert.equal(messages, initialMessages, 'silence must not publish cached inputs');
      let report;
      routes['/report']({}, { json: value => { report = value; } });
      for (const id of ['apparentWind.smoothed', 'windShiftFast', 'windShiftSlow']) {
        const warning = report.lifecycleWarnings.find(w => w.id === id);
        assert.equal(warning?.status, 'idle', id);
        assert.doesNotMatch(warning.message, /resubscrib/i);
      }
      deliverDelta(subscribers, [
        { path: 'environment.wind.speedApparent', value: 6 },
        { path: 'environment.wind.angleApparent', value: 0.5 }
      ]);
      routes['/report']({}, { json: value => { report = value; } });
      assert.equal(report.lifecycleWarnings.some(w => w.id === 'apparentWind.smoothed'), false);
      assert.equal(subscriptions, initialSubscriptions);
    } finally {
      await plugin.stop();
      cleanup();
    }
  });
});
