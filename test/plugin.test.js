'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
      version: '2.28.0',
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
    plugin = require('../index.js')(shim.app);
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
      const plugin = require('../index.js')(app);
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

  it('GET /settings returns current options with _bounds', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
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
      const plugin = require('../index.js')(app);
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

describe('memory leak / feedback loop detection (Issue #22)', () => {
  it('handleMessage call count stays bounded without feedback (sanity check)', async () => {
    // No feedback shim — handleMessage is a no-op counter.
    // One seed apparent-wind delta should fire calculate() once → one handleMessage.
    const { app, cleanup, subscribers, messageCount } = createTrackingShim({
      backCalculateApparentWind: true,
      stalenessDetection: false,
    });

    try {
      const plugin = require('../index.js')(app);
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
      stalenessDetection: false,
    });

    try {
      const plugin = require('../index.js')(app);
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
      stalenessDetection: false,
    });

    try {
      const plugin = require('../index.js')(app);
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
  it('start() completes without throwing', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw');
    } finally {
      cleanup();
    }
  });

  it('stop() resolves cleanly after start()', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
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
      const plugin = require('../index.js')(app);
      plugin.start();
      await plugin.stop();
      assert.doesNotThrow(() => plugin.start(), 'second start() must not throw');
      await assert.doesNotReject(() => plugin.stop(), 'second stop() must resolve');
    } finally {
      cleanup();
    }
  });
});
