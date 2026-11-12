// RM probe for the latent mid-suite tmp-file deletion race (hunt notes live in
// the macro test's comment, test/host.test.mjs). Usage:
//   NODE_OPTIONS="--import ./test/debug-rm.mjs" node test/host.test.mjs
// Any instrumentation perturbs the scheduler enough to hide the race — that is
// itself a finding. armStack flips on after 3s to keep the early phase at
// near-zero cost; while on, every rm/rmSync of a toolbox .png logs its stack.
import fs from 'node:fs';
import fsp from 'node:fs/promises';

let armStack = false;
setTimeout(() => {
  armStack = true;
}, 3000);

const wrap =
  (fn, name) =>
  (...args) => {
    const p = String(args[0]);
    if (armStack && p.includes('dsh-media-toolbox') && p.endsWith('.png')) {
      console.error(`RMHIT ${name} ${p}`);
      console.error((new Error().stack || '').split('\n').slice(2, 8).join('\n'));
    }
    return fn(...args);
  };

fs.rm = wrap(fs.rm.bind(fs), 'fs.rm');
fs.rmSync = wrap(fs.rmSync.bind(fs), 'fs.rmSync');
fsp.rm = wrap(fsp.rm.bind(fsp), 'fsp.rm');
