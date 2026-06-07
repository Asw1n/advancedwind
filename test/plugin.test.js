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
      version: '2.24.0',
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
