// Contract check for the built browser artifact (`client.js`).
//
// The bundle is a script, not a module: it calls window.__ModuleLoader__.load
// and expects the loader to hand it React through the factory's `require`.
// Running it here with those two stubs proves the build still produces
// something the Host can mount — the failure mode this catches is a build
// whose banner/footer shape quietly stopped matching the loader.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const calls = [];
const React = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment',
};

globalThis.window = { __ModuleLoader__: { load: (mod) => calls.push(mod) } };
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// No document stub: the artifact must survive a document-less load exactly
// like the Host does when it only evaluates the bundle's contract.
// eslint-disable-next-line no-new-func -- the artifact is a classic script
new Function('window', 'globalThis', source)(globalThis.window, globalThis);

assert.equal(calls.length, 1, 'the bundle registers exactly one loader entry');
const mod = calls[0];
assert.equal(mod.id, 'dsh-media-converter', 'the loader id must equal the package name');

const plugin = mod.factory((name) => {
  assert.equal(name, 'react', 'the factory may only require react from the module table');
  return React;
});
assert.equal(typeof plugin.apply, 'function', 'the loader needs an apply()');
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'declared client dependencies');

const registered = [];
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (_slot, callback) => callback(),
    register: (entry) => {
      registered.push(entry.name);
      return entry;
    },
  },
  locale: { bind: () => (key) => key, register: () => () => {} },
};
plugin.apply(ctx);
assert.deepEqual(registered.sort(), ['main', 'sidebar.panellist'], 'both slots are registered');

console.log('client-bundle.test.mjs: ok');
