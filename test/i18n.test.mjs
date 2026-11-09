// The panel's dictionary contract, checked against the source.
//
// The real guard is the type in src/client/locales.ts: `en` must satisfy
// Record<MediaConvertKey, string>, so a forgotten translation fails
// `npm run typecheck`. This file is the belt around that braces — it catches
// what a type cannot express: a t('key') that names no dictionary entry, and
// a dictionary entry nobody reads any more.
//
// Node 20 is the CI floor, so the dictionary is read as text: it is TypeScript
// and the test must not need a type stripper.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, root), 'utf8');

// Every source file that may call t(). The dictionary itself is excluded: it
// holds the keys, it never uses them.
function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|vue)$/.test(entry.name) && full !== 'src/client/locales.ts') out.push(full);
  }
  return out;
}

// The dictionary block: from its marker to the line that closes it at column
// zero. Braces are not counted — a value may hold them ({name} is the
// platform's own placeholder syntax) and that would throw the count off.
function block(text, marker) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  assert.notEqual(start, -1, `locales.ts is missing "${marker}"`);
  const end = lines.findIndex((line, i) => i > start && (line === '};' || line === '} as const;'));
  assert.notEqual(end, -1, `locales.ts: unterminated "${marker}"`);
  return lines.slice(start + 1, end).join('\n');
}

const locales = read('src/client/locales.ts');
const keysOf = (text) => [...text.matchAll(/^ {2}'([^']+)':/gm)].map((match) => match[1]);
const zhKeys = keysOf(block(locales, 'export const zh = {'));
const enKeys = keysOf(block(locales, 'export const en'));

// zh is the source of truth; en must carry exactly its keys. The type in
// locales.ts already enforces this at compile time — this is the runtime
// belt, and it does not insist on the same order: a translator may add the
// same key at a different spot in each file.
assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), 'zh and en must carry the same keys');

const files = sources('src/client');
const text = files.map(read).join('\n');

// Every literal t('key') must name a dictionary entry. A typo would otherwise
// show the raw key on screen: the platform falls back to the key itself.
const missing = [];
for (const file of files) {
  for (const match of read(file).matchAll(/(?<![A-Za-z0-9_$])t\(\s*'([^']+)'/g)) {
    // A literal ending in '.' is the prefix of a dynamic key (t('kind.' + kind)),
    // not a key of its own; the family check below covers those.
    if (match[1].endsWith('.')) continue;
    if (!zhKeys.includes(match[1])) missing.push(`${file}: ${match[1]}`);
  }
}
assert.deepEqual(missing, [], 'every t() call must name a dictionary key');

// Dynamic keys (t('kind.' + kind)) are not literals, so their families are
// collected from the concatenation and template shapes they are built with.
// A key of a known family counts as used even if it never appears verbatim.
//
// The families are pinned: a wider one would silently mark dead keys as used
// (t('meta.' + x) would cover every meta.* key), so a new shape has to be
// added here on purpose.
const FAMILIES = ['action.reveal.', 'group.', 'hint.', 'history.state.', 'kind.', 'meta.key.', 'meta.type.'];
const families = new Set();
for (const match of text.matchAll(/'([A-Za-z0-9_.]+\.)'\s*\+/g)) families.add(match[1]);
for (const match of text.matchAll(/`([A-Za-z0-9_.]+\.)\$\{/g)) families.add(match[1]);
assert.deepEqual(
  [...families].sort(),
  FAMILIES,
  'the dynamic key families changed: add the new family to FAMILIES on purpose, or narrow the two patterns if the match is not a translation',
);

// A key counts as used when it appears as a complete quoted literal, the way
// t('kind.video') names it. A bare substring would let a key hide behind a
// longer one: 33 of the 260 keys are a prefix of another key.
const dead = zhKeys.filter((key) => !text.includes(`'${key}'`) && !FAMILIES.some((f) => key.startsWith(f)));
assert.deepEqual(
  dead,
  [],
  'these dictionary keys are never used; delete them from zh and en. If a key is built \
with a dynamic shape this test does not recognise, extend the two family patterns above.',
);

// The Vue panel lives outside the React tree: it re-renders only when the `t`
// prop changes identity. The platform mints a fresh `t` per locale revision
// only for a slot that declares its namespace, so the main slot must declare
// `locale: NS` and hand `Shell` straight to the platform. A closure capturing
// our own stable `t` would shadow the injected seat, and the panel would
// silently keep the old language — no error, just stale text.
assert(
  /register\(\{[^}]*locale: NS[^}]*\}, Shell\)/.test(read('src/client/index.ts')),
  'the main slot must register Shell directly with locale: NS: the platform injects a fresh t only for a slot that declares its namespace, and the Vue panel only re-renders when that t changes identity',
);

console.log('i18n.test.mjs: ok');
