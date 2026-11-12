import assert from 'node:assert/strict';

import { parseState, restoreDecision, serializeState } from '../dist/lib/state.js';

// parseState: garbage in, null out — startup must never choke on state.
assert.equal(parseState('not json'), null);
assert.equal(parseState('{"schemaVersion":2}'), null);
assert.equal(
  parseState('{"schemaVersion":1,"uploads":"nope","runs":[],"interrupted":[],"latestRun":"","ptcRates":{}}'),
  null,
);
const good = {
  schemaVersion: 1,
  uploads: [],
  runs: [],
  latestRun: 'r1',
  ptcRates: { copy: 1, hardware: 1, video: 1, audio: 1, imageMs: 1 },
  interrupted: [],
};
assert.deepEqual(parseState(serializeState(good)), good, 'a v1 document round-trips');

// restoreDecision: gone → drop; touched → reprobe; untouched → adopt.
assert.equal(restoreDecision({ size: 10, mTimeMs: 5 }, null), 'drop');
assert.equal(restoreDecision({ size: 10, mTimeMs: 5 }, { size: 10, mtimeMs: 5 }), 'adopt');
assert.equal(restoreDecision({ size: 10, mTimeMs: 5 }, { size: 11, mtimeMs: 5 }), 'reprobe');
assert.equal(restoreDecision({ size: 10, mTimeMs: 5 }, { size: 10, mtimeMs: 6 }), 'reprobe');
assert.equal(restoreDecision({ size: 10 }, { size: 10, mtimeMs: 5 }), 'reprobe', 'no stored mtime always re-probes');

console.log('state.test.mjs: ok');
