// Regression test for the "stale apparent-wind source filter" deadlock.
//
// Scenario:
//   - A user had an older wind instrument; its source label ("n2k.OLD") was
//     saved into the plugin config as windSpeedSource.
//   - The instrument was replaced; the new one publishes apparent wind under
//     source "n2k.1".
//   - The user opens the plugin webapp and tries to fix the source via the
//     dropdown.
//
// Bug (pre-fix):
//   - The apparent-wind input handler's label filter rejects every n2k.1
//     delta because the stale label ("n2k.OLD") doesn't match. The path-match
//     branch still records "n2k.1" in the sources set, so the dropdown shows
//     it as an option, but no value is captured. polar.ready stays false,
//     the smoother never samples, apparentWind.onChange never fires, and
//     calculate() — the only drainer of `changedOptions` — never runs.
//   - Therefore picking "n2k.1" in the UI updates the in-memory `options`
//     mirror but never reaches the handler. The form looks right, the data
//     never appears, and the user is stuck.
//
// Fix:
//   - PUT /settings drains changedOptions immediately by calling
//     applyOptionChanges() instead of waiting for the next calculate()
//     cycle.
//
// What this test checks:
//   1. With a stale `windSpeedSource`, n2k.1 deltas are observed (source
//      shows up in the dropdown) but the smoother stays at 0 samples.
//   2. PUT /settings to the correct source causes the next n2k.1 delta to
//      flow end-to-end (smoother samples, state.ready=true, magnitude > 0).
//
// Without the fix, step 2 fails: nSamples stays 0 and ready stays false.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path  = require('node:path');

// ---------------------------------------------------------------------------
// Minimal SK app mock — only the surface the plugin & signalkutilities use.
// ---------------------------------------------------------------------------
function makeApp(initialConfig) {
  // Stored config is wrapped the way SK serves it from readPluginOptions().
  let stored = { configuration: { ...initialConfig } };
  const deltaHandlers = [];

  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    config: { port: 3000 },
    selfContext: 'vessels.self',
    readPluginOptions() { return stored; },
    savePluginOptions(opts, cb) {
      stored = { configuration: { ...opts } };
      if (cb) cb(null);
    },
    // signalkutilities calls getSelfPath().meta — return undefined so the
    // handler falls back to the REST cache (which we serve via fetch below).
    getSelfPath() { return undefined; },
    registerDeltaInputHandler(fn) { deltaHandlers.push(fn); },
    // Apparent wind subscribes with passOn=false (preventDuplication=true),
    // so it never hits subscriptionmanager. Other inputs do, but we don't
    // care about them for this test.
    subscriptionmanager: { subscribe() {} },
    // The plugin's own back-calc output goes through handleMessage. Route it
    // back into the delta chain so the isOwnSource check is exercised
    // realistically (it should filter the plugin's deltas out).
    handleMessage(_pluginId, msg) { this._deliver(msg); },

    // Test-only helper: push a delta through the registered handler chain.
    _deliver(delta) {
      let i = 0;
      const next = (d) => {
        if (i >= deltaHandlers.length) return;
        const h = deltaHandlers[i++];
        h(d, next);
      };
      next(delta);
    },
  };
}

// Minimal Express-like router mock.
function makeRouter() {
  const routes = { get: {}, put: {} };
  return {
    get(p, h) { routes.get[p] = h; },
    put(p, h) { routes.put[p] = h; },
    routes,
  };
}

// /report response helper.
function getReport(router) {
  let body;
  router.routes.get['/report'](
    {},
    { status() { return this; }, json(j) { body = j; } }
  );
  return body;
}

// PUT /settings helper.
function putSettings(router, partial) {
  let body;
  router.routes.put['/settings'](
    { body: partial },
    { status() { return this; }, json(j) { body = j; } }
  );
  return body;
}

// REST /meta is fire-and-forget — always succeed so pathKnown becomes true
// quickly (doesn't change the test outcome, but keeps the warnings clean).
global.fetch = async () => ({
  ok: true,
  json: async () => ({ units: 'm/s' }),
});

// Yield long enough for fire-and-forget promises (_fetchRestMeta) to settle.
const tick = () => new Promise((r) => setImmediate(r));

// Apparent-wind delta from the *current* instrument.
const APPARENT_DELTA = {
  context: 'vessels.self',
  updates: [{
    $source: 'n2k.1',
    values: [
      { path: 'environment.wind.speedApparent', value: 5.5 },
      { path: 'environment.wind.angleApparent', value: -0.69 },
    ],
  }],
};

const STALE_CONFIG = {
  version: '3.3',
  // The previous wind instrument's source — no longer publishing.
  windSpeedSource: 'n2k.OLD',
  preventDuplication: true,
  backCalculateApparentWind: true,
  calculateGroundWind: false,
  correctForMisalign: false,
  correctForMastRotation: false,
  correctForMastHeel: false,
  correctForMastMovement: false,
  correctForUpwash: false,
  correctForLeeway: false,
  correctForHeight: false,
  stalenessDetection: true,
};

const pluginFactory = require(path.resolve(__dirname, '..', 'index.js'));

test('stale windSpeedSource discovers n2k.1 source but blocks the value', async () => {
  const app = makeApp(STALE_CONFIG);
  const plugin = pluginFactory(app);
  const router = makeRouter();
  plugin.registerWithRouter(router);
  await plugin.start();

  // Send a real delta from the actual current source.
  app._deliver(APPARENT_DELTA);
  await tick();

  const report = getReport(router);
  const aw = report.polars['apparentWind.smoothed'];

  assert.equal(aw.state.ready, false,
    'apparent wind should not be ready — filter rejects the unknown source');
  assert.equal(aw.state.hasDelta, false,
    'smoother should not have sampled yet');
  assert.equal(aw.state.nSamples, 0, 'no samples taken');
  assert.deepEqual(aw.state.sources, ['n2k.1'],
    'source name is still discovered (this is what populates the dropdown)');

  await plugin.stop();
});

test('picking the correct source via PUT /settings unblocks apparent wind',
async () => {
  const app = makeApp(STALE_CONFIG);
  const plugin = pluginFactory(app);
  const router = makeRouter();
  plugin.registerWithRouter(router);
  await plugin.start();

  // First delta: rejected by the stale filter.
  app._deliver(APPARENT_DELTA);
  await tick();
  assert.equal(getReport(router).polars['apparentWind.smoothed'].state.ready,
    false, 'precondition: stuck before reconfiguration');

  // User picks "n2k.1" in the dropdown. With the fix this drains
  // changedOptions immediately via applyOptionChanges(). Without the fix
  // it just sits in changedOptions waiting for a calculate() that will
  // never happen.
  putSettings(router, { windSpeedSource: 'n2k.1' });

  // Next delta arrives.
  app._deliver(APPARENT_DELTA);
  await tick();

  const aw = getReport(router).polars['apparentWind.smoothed'];

  assert.equal(aw.state.ready, true,
    'apparent wind should be ready once the new source filter is active');
  assert.ok(aw.state.nSamples > 0,
    'smoother should have sampled at least once');
  assert.ok(aw.magnitude > 0,
    'magnitude should reflect the n2k.1 wind value (~5.5 m/s)');

  await plugin.stop();
});
