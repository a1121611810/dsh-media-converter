// Client half of dsh-media-converter — the media toolbox page.
//
// Entry for the DSH client loader: the build wraps this module in
// window.__ModuleLoader__.load({ id, factory(require) }) and hands React in
// through globalThis.__dshReact (the loader's factory scope cannot be reached
// from inside the bundled IIFE).
//
// React only parks the <media-panel> custom element in the slot; the panel
// itself is Vue (src/client/App.vue).
import './vue/elements.js';
import { NS, en, zh } from './locales.js';
import type { StatusResponse } from '../../index.js';

// React is handed in by the loader, so the bundle carries no React of its
// own: only the three hooks this file touches are declared here.
interface ReactRef<T> {
  current: T;
}
interface ReactSurface {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useRef<T>(initial: T): ReactRef<T>;
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void];
}
// The <media-panel> custom element carries the translator on the element.
interface PanelElement extends HTMLElement {
  t: (key: string) => string;
}

declare global {
  // The loader's factory parks React here before the bundle runs.
  var __dshReact: ReactSurface;
}

// The plugin services this page uses: the locale translator and the slots
// it registers into. Only the calls below are declared.
interface SlotRegistration {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: () => string;
  locale?: string;
}
interface PluginContext {
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, language: string, dictionary: Record<string, string>): () => void;
  };
  slots: {
    inject(name: string, injector: () => void): void;
    register(registration: SlotRegistration, component: unknown): () => void;
  };
  effect(effect: () => void | (() => void)): void;
}
const React = globalThis.__dshReact;
const h = React.createElement;
const PANEL_ID = 'media-convert';

function PanelIcon({ size }: { size?: number }) {
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 8h13' }),
    h('path', { d: 'm14 4.5 3.5 3.5L14 11.5' }),
    h('path', { d: 'M20 16H7' }),
    h('path', { d: 'm10 12.5L6.5 16l3.5 3.5' }),
  );
}

// The composer slot entries receive its own edit face: undoable text
// insertion, not DOM poking.
interface InputActions {
  captureInsertion(): { start: number; end: number };
  insertText(text: string, span: { start: number; end: number }): boolean;
}

// Dropped into the draft on click; the user edits the placeholders (file,
// range, format) and sends. Chinese works for the model either way.
const COMPOSER_TEMPLATE = '把 xx.mov 裁 0:10 到 1:00 转成 mp4';

// One status read shared by every mount of the composer button, so disabling
// the button in settings actually removes it from the tool row.
let buttonStatusPromise: Promise<StatusResponse | null> | null = null;
const buttonConfig = () => {
  if (!buttonStatusPromise) {
    buttonStatusPromise = fetch('/api/media-convert/status')
      .then((resp) => resp.json())
      .then((data) => data as StatusResponse)
      .catch(() => null);
  }
  return buttonStatusPromise;
};

const COMPOSER_CSS = `
.mc-composer-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: background-color .2s, color .2s; }
.mc-composer-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mc-settings { padding: 4px 2px; display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); max-width: 560px; }
.mc-settings-title { margin: 0; font-size: 15px; font-weight: 600; }
.mc-settings-list { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
.mc-settings-list dt { color: var(--dsw-alias-label-secondary, inherit); }
.mc-settings-list dd { margin: 0; word-break: break-all; }
.mc-settings-section { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2, transparent); }
.mc-settings-section > h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.mc-settings-form { display: flex; flex-direction: column; gap: 12px; }
.mc-settings-field { display: flex; flex-direction: column; gap: 4px; }
.mc-settings-field > span { color: var(--dsw-alias-label-secondary, inherit); }
.mc-settings-field > small { color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; }
.mc-settings-input { box-sizing: border-box; width: 100%; max-width: 420px; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.mc-settings-input:focus { outline: none; border-color: var(--dsw-static-deepseek-500, #4d6bfe); }
.mc-settings-save { align-self: flex-start; padding: 6px 16px; border: 0; border-radius: 6px; background: var(--dsw-static-deepseek-500, #4d6bfe); color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
.mc-settings-save:disabled { opacity: 0.6; cursor: default; }
.mc-settings-note { margin: 0; font-size: 12px; }
.mc-settings-note.ok { color: var(--dsw-alias-state-success-fg, #2ba471); }
.mc-settings-note.err { color: var(--dsw-alias-state-danger-fg, #d54941); }
.mc-settings-hint { margin: 0; color: var(--dsw-alias-label-secondary, inherit); line-height: 1.6; }
.mc-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mc-settings-refresh { padding: 5px 12px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: background-color .2s, color .2s; }
.mc-settings-refresh:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mc-settings-grouprow { display: flex; align-items: center; gap: 8px; }
.mc-settings-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.mc-settings-rowtail { margin-left: auto; display: inline-flex; gap: 6px; }
.mc-settings-mini { width: 24px; height: 24px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mc-settings-mini:disabled { opacity: 0.4; cursor: default; }
`;

// Editable form backed by the settings service: the POST merges into the
// profile document (validated against the exported Config schema) and the
// host applies it to its running state, so a save is effective at once —
// the desktop loader alone would not re-apply the plugin.
const GROUP_KEYS = ['convert', 'edit', 'view'];

function SettingsPage({ t }: { t: (key: string) => string }) {
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [form, setForm] = React.useState({
    outputDir: '',
    ffmpegPath: '',
    maxUploadMb: '2048',
    uploadTtlMinutes: '120',
    queueLimit: '2000',
    composerButton: true,
    persistState: false,
  });
  const [rows, setRows] = React.useState<{ key: string; on: boolean }[]>([]);
  const [phase, setPhase] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [extPhase, setExtPhase] = React.useState<'idle' | 'importing' | 'error'>('idle');
  // One save at a time: a second delete computed from the stale list would
  // resurrect the first deleted pack.
  const [extBusy, setExtBusy] = React.useState(false);
  const [extError, setExtError] = React.useState('');
  const readyRef = React.useRef(false);

  const load = () => {
    fetch('/api/media-convert/status')
      .then((resp) => resp.json())
      .then((data) => {
        const next = data as StatusResponse;
        setStatus(next);
        // Initialize the editable state once per page open; later refreshes
        // only update the "currently in effect" display.
        if (!readyRef.current) {
          readyRef.current = true;
          setForm({
            outputDir: '',
            ffmpegPath: '',
            maxUploadMb: String(next.maxUploadMb),
            uploadTtlMinutes: String(next.uploadTtlMinutes),
            queueLimit: String(next.queueLimit),
            composerButton: next.composerButton !== false,
            persistState: next.persistState === true,
          });
          setRows(
            [...next.groups, ...GROUP_KEYS.filter((key) => !next.groups.includes(key))].map((key) => ({
              key,
              on: next.groups.includes(key),
            })),
          );
        }
      })
      .catch(() => {});
  };
  React.useEffect(load, []);

  const save = () => {
    setPhase('saving');
    fetch('/api/media-convert/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        outputDir: form.outputDir,
        ffmpegPath: form.ffmpegPath,
        maxUploadMb: Number(form.maxUploadMb),
        uploadTtlMinutes: Number(form.uploadTtlMinutes),
        queueLimit: Number(form.queueLimit),
        composerButton: form.composerButton,
        persistState: form.persistState,
        groups: rows
          .filter((row) => row.on)
          .map((row) => row.key)
          .join(','),
      }),
    })
      .then((resp) => resp.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || 'save failed');
        setPhase('saved');
        // The host applies the save to its running state, so re-reading shows
        // the now-effective values in the "currently in effect" block.
        setTimeout(() => {
          load();
          setPhase('idle');
        }, 700);
      })
      .catch(() => setPhase('error'));
  };

  // Packs carry both languages; pick like the panel does (zh unless the
  // browser says en).
  const pickExt = (label: { zh: string; en: string }) =>
    (navigator.language || '').toLowerCase().startsWith('en') ? label.en : label.zh;
  const saveExtensions = (packs: unknown[]) => {
    setExtBusy(true);
    return fetch('/api/media-convert/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extensions: JSON.stringify(packs) }),
    })
      .then((resp) => resp.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || 'save failed');
        setExtPhase('idle');
        setExtError('');
        setTimeout(load, 300);
      })
      .catch((err) => {
        setExtError(String((err && (err as Error).message) || err));
        setExtPhase('error');
      })
      .finally(() => setExtBusy(false));
  };
  const importPack = (event: { target: HTMLInputElement }) => {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    setExtPhase('importing');
    void file
      .text()
      .then((text) => {
        let manifest: { id?: string };
        try {
          manifest = JSON.parse(text);
        } catch {
          setExtError(t('settings.ext.importFailed').replace('%s', 'invalid JSON'));
          setExtPhase('error');
          return;
        }
        const current = (status?.extensions || []).map((pack) => JSON.parse(pack.raw) as { id?: string });
        if (current.some((pack) => pack.id === manifest.id)) {
          setExtError(t('settings.ext.duplicate').replace('%s', String(manifest.id)));
          setExtPhase('error');
          return;
        }
        void saveExtensions([...current, manifest]);
      })
      .catch(() => {
        setExtError(t('settings.ext.importFailed').replace('%s', 'read error'));
        setExtPhase('error');
      });
  };
  const removePack = (id: string) => {
    const rest = (status?.extensions || []).filter((pack) => pack.id !== id).map((pack) => JSON.parse(pack.raw));
    void saveExtensions(rest);
  };

  if (!status) {
    return h('div', { className: 'mc-settings' }, h('p', { className: 'mc-settings-hint' }, t('error.network')));
  }
  const set =
    (key: 'outputDir' | 'ffmpegPath' | 'maxUploadMb' | 'uploadTtlMinutes' | 'queueLimit') =>
    (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));
  const field = (
    label: string,
    hint: string,
    key: 'outputDir' | 'ffmpegPath' | 'maxUploadMb' | 'uploadTtlMinutes' | 'queueLimit',
    placeholder: string,
  ) =>
    h(
      'label',
      { className: 'mc-settings-field' },
      h('span', null, label),
      h('input', { className: 'mc-settings-input', value: form[key], placeholder, onInput: set(key) }),
      h('small', null, hint),
    );
  const move = (index: number, delta: number) =>
    setRows((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const toggle = (index: number) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, on: !row.on } : row)));
  // An older host predates probeMode; only a known value earns a verdict.
  const probeKnown = status.probeMode === 'ffprobe' || status.probeMode === 'ffmpeg';
  return h(
    'div',
    { className: 'mc-settings' },
    h(
      'div',
      { className: 'mc-settings-head' },
      h(
        'h3',
        { className: 'mc-settings-title' },
        t('settings.title') + (status.version ? ` · v${status.version}` : ''),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mc-settings-refresh',
          title: t('settings.refresh.title'),
          onClick: () => location.reload(),
        },
        t('settings.refresh'),
      ),
    ),
    // Read-only facts about the box the plugin runs on. The probe verdict and
    // its fix guidance live here, out of the editable form below.
    h(
      'section',
      { className: 'mc-settings-section' },
      h('h4', null, t('settings.section.env')),
      h(
        'dl',
        { className: 'mc-settings-list' },
        h('dt', null, t('settings.field.ffmpeg')),
        h('dd', null, status.ffmpegPath || '—'),
        h('dt', null, t('settings.probe')),
        h(
          'dd',
          null,
          h(
            'span',
            {
              className: !probeKnown
                ? ''
                : status.probeMode === 'ffprobe'
                  ? 'mc-settings-note ok'
                  : 'mc-settings-note err',
            },
            !probeKnown
              ? '—'
              : status.probeMode === 'ffprobe'
                ? t('settings.probe.ffprobe')
                : t('settings.probe.ffmpeg'),
          ),
        ),
      ),
      status.probeMode === 'ffmpeg' ? h('p', { className: 'mc-settings-note err' }, t('settings.probe.fix')) : null,
    ),
    // Extension packs (data-only manifests): import a JSON pack to add preset
    // actions to the detail page and the batch targets; removing one restores
    // the built-in behaviour. The Host validates the whole batch, so a bad
    // import never half-installs.
    h(
      'section',
      { className: 'mc-settings-section' },
      h('h4', null, t('settings.ext.title')),
      h('p', { className: 'mc-settings-note' }, t('settings.ext.hint')),
      (status.extensions || []).length
        ? h(
            'ul',
            { className: 'mc-settings-ext' },
            (status.extensions || []).map((pack) =>
              h(
                'li',
                { key: pack.id },
                h(
                  'span',
                  null,
                  pickExt(pack.name) + ' · ' + t('settings.ext.actions').replace('%s', String(pack.actions.length)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mc-link',
                    disabled: extBusy,
                    onClick: () => removePack(pack.id),
                  },
                  t('settings.ext.delete'),
                ),
              ),
            ),
          )
        : h('p', { className: 'mc-settings-note' }, t('settings.ext.empty')),
      h(
        'label',
        { className: 'mc-btn mc-btn-ghost mc-settings-import' },
        extPhase === 'importing' ? '…' : t('settings.ext.import'),
        h('input', {
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: importPack,
        }),
      ),
      extPhase === 'error' && extError ? h('p', { className: 'mc-settings-note err' }, extError) : null,
    ),
    // The one place to edit: every field names its live value in the hint, so
    // there is no separate "current" list to cross-check while typing.
    h(
      'section',
      { className: 'mc-settings-section' },
      h('h4', null, t('settings.section.general')),
      h(
        'div',
        { className: 'mc-settings-form' },
        field(
          t('settings.field.outputDir'),
          `${t('settings.current')}: ${status.outputDir} · ${t('settings.field.outputDir.hint')}`,
          'outputDir',
          status.outputDir,
        ),
        field(
          t('settings.field.ffmpeg'),
          `${t('settings.current')}: ${status.ffmpegPath || '—'} · ${t('settings.field.ffmpeg.hint')}`,
          'ffmpegPath',
          status.ffmpegPath || '',
        ),
        field(
          t('settings.field.maxUpload'),
          `${t('settings.current')}: ${status.maxUploadMb}`,
          'maxUploadMb',
          String(status.maxUploadMb),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mc-settings-save',
            disabled: phase === 'saving',
            onClick: save,
          },
          t(phase === 'saving' ? 'settings.saving' : 'settings.save'),
        ),
        phase === 'saved' ? h('p', { className: 'mc-settings-note ok' }, t('settings.saved')) : null,
        phase === 'error' ? h('p', { className: 'mc-settings-note err' }, t('settings.error')) : null,
      ),
    ),
    // How long sources survive and how many rows a rebuilt page restores.
    // Conversions run on this machine, so a DSH restart is called out here.
    h(
      'section',
      { className: 'mc-settings-section' },
      h('h4', null, t('settings.section.queue')),
      h(
        'div',
        { className: 'mc-settings-form' },
        h(
          'label',
          { className: 'mc-settings-check' },
          h('input', {
            type: 'checkbox',
            checked: form.persistState,
            onChange: (event: { target: { checked: boolean } }) =>
              setForm((current) => ({ ...current, persistState: event.target.checked })),
          }),
          t('settings.persistState'),
        ),
        h('small', { className: 'mc-settings-hint' }, t('settings.persistState.hint')),
        field(
          t('settings.field.uploadTtl'),
          `${t('settings.current')}: ${status.uploadTtlMinutes} · ${t('settings.field.uploadTtl.hint')}`,
          'uploadTtlMinutes',
          String(status.uploadTtlMinutes),
        ),
        field(
          t('settings.field.queueLimit'),
          `${t('settings.current')}: ${status.queueLimit} · ${t('settings.field.queueLimit.hint')}`,
          'queueLimit',
          String(status.queueLimit),
        ),
        h('p', { className: 'mc-settings-hint' }, t('settings.restart.note')),
      ),
    ),
    // Presentation switches and panel-module order: cosmetic, but saved by
    // the same button as the fields above.
    h(
      'section',
      { className: 'mc-settings-section' },
      h('h4', null, t('settings.section.ui')),
      h(
        'div',
        { className: 'mc-settings-form' },
        h(
          'label',
          { className: 'mc-settings-check' },
          h('input', {
            type: 'checkbox',
            checked: form.composerButton,
            onChange: (event: { target: { checked: boolean } }) =>
              setForm((current) => ({ ...current, composerButton: event.target.checked })),
          }),
          t('settings.composerButton'),
        ),
      ),
      h(
        'div',
        { className: 'mc-settings-field' },
        h('span', null, t('settings.groups')),
        rows.map((row, index) =>
          h(
            'div',
            { className: 'mc-settings-grouprow', key: row.key },
            h(
              'label',
              { className: 'mc-settings-check' },
              h('input', { type: 'checkbox', checked: row.on, onChange: () => toggle(index) }),
              t(`group.${row.key}`),
            ),
            h(
              'span',
              { className: 'mc-settings-rowtail' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-settings-mini',
                  disabled: index === 0,
                  title: t('settings.groups.up'),
                  onClick: () => move(index, -1),
                },
                '↑',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-settings-mini',
                  disabled: index === rows.length - 1,
                  title: t('settings.groups.down'),
                  onClick: () => move(index, 1),
                },
                '↓',
              ),
            ),
          ),
        ),
        h('small', null, t('settings.groups.hint')),
      ),
    ),
    h('p', { className: 'mc-settings-hint' }, t('settings.hint')),
  );
}

function ComposerButton({ inputActions, t }: { inputActions?: InputActions; t: (key: string) => string }) {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let disposed = false;
    buttonConfig().then((status) => {
      // A failed read defaults to showing the button: availability first.
      if (!disposed) setEnabled(status ? status.composerButton !== false : true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  const onClick = () => {
    if (!inputActions || typeof inputActions.insertText !== 'function') return;
    const applied = inputActions.insertText(COMPOSER_TEMPLATE, inputActions.captureInsertion());
    if (!applied) return;
    const composer = document.querySelector('[data-composer-input]');
    if (composer instanceof HTMLElement) composer.focus({ preventScroll: true });
  };
  if (enabled !== true) return null;
  return h(
    'button',
    { type: 'button', className: 'mc-composer-btn', title: t('composer.title'), onClick },
    h(PanelIcon, { size: 14 }),
    t('composer.label'),
  );
}

const CSS = `
      .mc-host, media-panel { display: block; height: 100%; }
      .mc-page { width: 100%; max-width: 780px; margin: 0 auto; height: 100%; min-height: 0; overflow-y: auto; padding: 22px 26px 56px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; font-size: 14px; color: var(--dsw-alias-label-primary, inherit); }
      /* The page is a fixed-height flex column: without this, tall content
         squashes the player / compare box instead of scrolling. */
      .mc-page > * { flex-shrink: 0; }
      .mc-head { display: flex; flex-direction: column; gap: 4px; }
      .mc-title { margin: 0; font-size: 18px; font-weight: 600; }
      .mc-sub { margin: 0; line-height: 1.6; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 56px 20px; border-radius: 14px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); cursor: pointer; text-align: center; transition: border-color .15s, background .15s; }
      .mc-drop:hover, .mc-drop.over { border-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-drop:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 2px; }
      .mc-drop-title { font-weight: 600; font-size: 15px; }
      .mc-drop-hint, .mc-muted { color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; }
      .mc-file { display: flex; align-items: center; gap: 12px; }
      .mc-file-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
      .mc-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-tag { flex: none; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); }
      .mc-btn { padding: 7px 16px; border-radius: 8px; cursor: pointer; font: inherit; white-space: nowrap; }
      .mc-btn:disabled { opacity: 0.55; cursor: default; }
      .mc-btn-primary { border: none; color: #fff; background: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-btn-primary:not(:disabled):hover { background: var(--dsw-static-deepseek-400, #6b8cff); }
      .mc-btn-ghost { background: transparent; color: var(--dsw-alias-label-primary, inherit); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); }
      .mc-row { display: flex; align-items: center; gap: 12px; }
      .mc-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .mc-grow { flex: 1; }
      .mc-input { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-input:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-name-input { flex: 0 1 300px; min-width: 120px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-name-input:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-time { width: 76px; box-sizing: border-box; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; text-align: center; font-variant-numeric: tabular-nums; }
      .mc-time:focus-visible, .mc-b64:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-search { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, transparent); }
      .mc-search input { flex: 1; border: none; outline: none; background: transparent; color: inherit; font: inherit; font-size: 15px; }
      .mc-act-group { margin: 14px 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-act { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: none; background: transparent; color: inherit; font: inherit; font-size: 14px; text-align: left; border-radius: 9px; cursor: pointer; }
      .mc-act:hover:not(:disabled), .mc-act.on { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }
      .mc-act:disabled { opacity: 0.45; cursor: not-allowed; }
      .mc-act-icon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); font-size: 13px; flex: none; }
      .mc-act-hint { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-panel { margin: 2px 0 8px 36px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); display: flex; flex-direction: column; gap: 10px; }
      .mc-player { display: block; width: 100%; max-height: 280px; border-radius: 10px; background: #000; object-fit: contain; }
      .mc-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .mc-toggle { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-toggle.on { border-color: var(--dsw-static-deepseek-500, #4d6bfe); font-weight: 600; }
      .mc-fig { display: flex; flex-direction: column; align-items: center; gap: 6px; margin: 0; min-width: 0; }
      .mc-fig img { max-width: 100%; max-height: 240px; border-radius: 8px; object-fit: contain; }
      .mc-fig-ph { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; min-height: 240px; padding: 12px; border-radius: 8px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; text-align: center; }
      .mc-cap { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: center; word-break: break-all; }
      compare-slider { display: block; }
      .mc-slider { position: relative; width: 100%; height: 300px; border-radius: 10px; overflow: hidden; cursor: ew-resize; touch-action: none; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-slider:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 2px; }
      .mc-slider img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; user-select: none; }
      .mc-slider-clip { position: absolute; inset: 0; }
      .mc-slider-handle { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.25); pointer-events: none; }
      .mc-slider-handle::after { content: ''; position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.35); }
      .mc-slider-tag { position: absolute; bottom: 8px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: rgba(0,0,0,0.55); color: #fff; pointer-events: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-slider-tag.left { left: 8px; }
      .mc-slider-tag.right { right: 8px; }
      .mc-bar { height: 6px; border-radius: 3px; overflow: hidden; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-bar > i { display: block; height: 100%; background: var(--dsw-static-deepseek-500, #4d6bfe); transition: width .25s; }
      .mc-bar.indet > i { width: 38%; animation: mc-slide 1.2s ease-in-out infinite; }
      @keyframes mc-slide { 0% { margin-left: -38%; } 100% { margin-left: 100%; } }
      .mc-error { color: var(--dsw-alias-state-error-primary, #d5483f); word-break: break-word; line-height: 1.6; }
      .mc-warn { color: var(--dsw-alias-state-warn-primary, #d5763f); line-height: 1.6; }
      .mc-warn-dismiss { margin-left: 8px; background: none; border: none; padding: 0; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
      .mc-history { list-style: none; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius: 10px; overflow: hidden; }
      .mc-history-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; }
      .mc-history-row + .mc-history-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-history-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-history-row.is-gone { opacity: 0.5; }
      .mc-history-dot { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6)); }
      .mc-history-dot.is-done { background: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-history-dot.is-error { background: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-history-dot.is-cancelled { background: var(--dsw-alias-state-warn-primary, #d5763f); }
      .mc-history-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .mc-history-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .mc-history-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .mc-history-chip { flex: none; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); }
      .mc-history-chip.is-done { color: var(--dsw-alias-state-success-primary, #2ba471); border-color: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-history-chip.is-error { color: var(--dsw-alias-state-error-primary, #d5483f); border-color: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-history-chip.is-cancelled { color: var(--dsw-alias-state-warn-primary, #d5763f); border-color: var(--dsw-alias-state-warn-primary, #d5763f); }
      .mc-history-chip.is-gone { color: var(--dsw-alias-state-error-primary, #d5483f); border-color: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-history-meta { display: flex; align-items: baseline; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); min-width: 0; overflow: hidden; white-space: nowrap; }
      .mc-history-meta > span:not(.mc-history-out) { flex: none; }
      .mc-history-out { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .mc-history-err { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d5483f); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-history-actions { flex: none; display: flex; align-items: center; gap: 10px; padding-top: 1px; }
      .mc-history-actions > a, .mc-history-actions > button { background: none; border: 0; padding: 2px 0; font: inherit; font-size: 12.5px; color: var(--dsw-static-deepseek-400, #6b8afd); cursor: pointer; text-decoration: none; white-space: nowrap; }
      .mc-history-actions > a:hover, .mc-history-actions > button:hover { color: var(--dsw-static-deepseek-500, #4d6bfe); text-decoration: underline; }
      .mc-history-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 200px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); border-radius: 16px; }
      .mc-history-empty svg { width: 34px; height: 34px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-history-more { margin-top: 10px; }
      .mc-history-bar { display: flex; align-items: center; gap: 14px; padding: 7px 12px; margin-bottom: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius: 10px; }
      .mc-history-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; user-select: none; }
      li .mc-history-check { flex: none; margin-top: 6px; cursor: default; }
      .mc-ok { font-weight: 600; color: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-foot { display: flex; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); word-break: break-all; }
      .mc-sep { height: 1px; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-meta-head { margin: 10px 0 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-meta-grid { display: grid; grid-template-columns: minmax(64px, max-content) 1fr; gap: 6px 16px; margin: 8px 0; font-size: 13px; }
      .mc-meta-grid > span:nth-child(odd) { color: var(--dsw-alias-label-secondary, inherit); overflow-wrap: anywhere; }
      .mc-meta-grid > span:nth-child(even) { word-break: break-word; min-width: 0; }
      .mc-meta-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 8px 0; }
      .mc-meta-field { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .mc-meta-field > span { flex: none; width: 40px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-meta-field > input { flex: 1; min-width: 0; }
      .mc-b64 { width: 100%; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
      .mc-pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; margin: 0; }
      .mc-result { display: flex; flex-direction: column; gap: 10px; }
      /* ---- motion: the DeepSeek harness motion language ----
         From www.deepseek.com/harness: expo-out entrances
         cubic-bezier(.19,1,.22,1), fade + rise (+ optional blur), 0.2s hovers,
         0.35s accent colours, and grid-template-rows 0fr->1fr disclosure. */
      .mc-page {
        --mc-ease: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
        --mc-ease-out: cubic-bezier(.19, 1, .22, 1);
      }
      .mc-btn { transition: background-color .2s, border-color .2s, color .2s, opacity .2s, box-shadow .2s; }
      .mc-toggle, .mc-select, .mc-name-input, .mc-time, .mc-input { transition: border-color .2s, background-color .2s; }
      .mc-search { transition: border-color .2s, box-shadow .2s; }
      .mc-search:focus-within { border-color: var(--dsw-static-deepseek-500, #4d6bfe); box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.12); }
      .mc-act { transition: background-color .2s, color .2s; }
      .mc-act-icon { transition: background-color .35s, color .35s; }
      .mc-act.on .mc-act-icon { background: var(--dsw-static-deepseek-500, #4d6bfe); color: #fff; }
      .mc-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .18s var(--mc-ease-out); }
      .mc-collapse.open { grid-template-rows: 1fr; }
      .mc-panel-clip { overflow: hidden; min-height: 0; contain: layout paint; }
      .mc-panel { animation: mc-fade .14s ease-out both; }
      .mc-result { animation: mc-rise .36s var(--mc-ease-out) both; }
      .mc-file, .mc-compare, .mc-slider { animation: mc-in .42s var(--mc-ease-out) both; }
      .mc-player { animation: mc-fade .2s ease-out both; }
      .mc-fig img { animation: mc-fade .14s ease-out both; }
      .mc-drop { transition: border-color .2s, background-color .2s, transform .3s var(--mc-ease-out); }
      .mc-drop.over { transform: scale(1.004); background: rgba(77, 107, 254, 0.05); }
      .mc-bar > i { transition: width .2s var(--mc-ease); }
      @keyframes mc-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes mc-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
      @keyframes mc-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) {
        .mc-page *, .mc-page *::before, .mc-page *::after {
          animation-duration: .001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: .001ms !important;
        }
      }

      /* ---- queue workbench ------------------------------------------------ */
      .mc-page { max-width: 960px; position: relative; }
      .mc-queue { position: relative; display: flex; flex-direction: column; gap: 14px; }
      .mc-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .mc-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12.5px; }
      .mc-check input { width: 15px; height: 15px; accent-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 260px; padding: 64px 24px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); border-radius: 16px; text-align: center; cursor: pointer; transition: border-color .2s, background-color .2s; }
      .mc-empty:hover, .mc-empty.over { border-color: var(--dsw-static-deepseek-500, #4d6bfe); background: rgba(77, 107, 254, 0.04); }
      .mc-empty svg { width: 34px; height: 34px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-empty-title { margin: 0; font-size: 16px; font-weight: 600; }
      .mc-empty-hint { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-empty-privacy { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-drop-overlay { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; border: 2px dashed var(--dsw-static-deepseek-500, #4d6bfe); border-radius: 14px; background: rgba(77, 107, 254, 0.06); font-weight: 600; pointer-events: none; }
      .mc-group { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 12px; margin: 10px 0; overflow: hidden; }
      .mc-group-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06)); }
      .mc-group-check { font-size: 12.5px; font-weight: 600; }
      .mc-group-label { font-size: 13px; font-weight: 600; }
      .mc-group-count { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-group-target { margin-left: auto; }
      .mc-group .mc-list-wrap { border: 0; }
      .mc-group .mc-item:first-child { border-top: 0; }
      .mc-list-wrap { display: flex; flex-direction: column; }
      .mc-list-head, .mc-item { display: grid; grid-template-columns: 20px 36px minmax(0, 1fr) 112px 58px 76px minmax(130px, auto) auto; align-items: center; gap: 6px 12px; }
      .mc-kind { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .mc-kind > span { flex: none; }
      .mc-row-target { width: 72px; min-width: 0; padding: 2px 4px; height: 24px; font-size: 11px; }
      .mc-list-head { padding: 2px 8px 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-list { list-style: none; margin: 0; padding: 0; }
      .mc-item { padding: 10px 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); transition: background-color .15s; content-visibility: auto; contain-intrinsic-size: auto 56px; }
      .mc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-thumb { width: 36px; height: 36px; box-sizing: border-box; border-radius: 6px; overflow: hidden; display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); color: var(--dsw-alias-label-secondary, inherit); }
      .mc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .mc-thumb svg { width: 18px; height: 18px; }
      .mc-item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; }
      .mc-kind { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-row-target { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap; }
      .mc-num { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: right; white-space: nowrap; }
      .mc-status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, inherit); }
      .mc-dot.dot-ok { background: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-dot.dot-error { background: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-dot.dot-warn { background: var(--dsw-alias-state-warn-primary, #d5763f); }
      .mc-dot.dot-busy { background: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-row-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
      .mc-link { border: 0; background: transparent; color: var(--dsw-static-deepseek-500, #4d6bfe); font: inherit; font-size: 12px; cursor: pointer; padding: 3px 5px; border-radius: 5px; }
      .mc-link:hover { text-decoration: underline; }
      .mc-link:disabled { opacity: .5; cursor: default; text-decoration: none; }
      .mc-icon-btn { width: 26px; height: 26px; display: grid; place-items: center; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 5px; cursor: pointer; }
      .mc-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); color: var(--dsw-alias-label-primary, inherit); }
      .mc-icon-btn:disabled { opacity: .45; cursor: default; }
      .mc-icon-btn svg { width: 14px; height: 14px; }
      .mc-rowbar { grid-column: 1 / -1; height: 3px; margin-top: -4px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-rowbar > i { display: block; height: 100%; background: var(--dsw-static-deepseek-500, #4d6bfe); transition: width .2s var(--mc-ease); }
      .mc-rowbar.indet > i { width: 38%; animation: mc-slide 1.2s ease-in-out infinite; }
      .mc-row-error { grid-column: 3 / -1; margin: 0; color: var(--dsw-alias-state-error-primary, #d5483f); font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .mc-modal { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.35); }
      .mc-modal-card { width: min(720px, 100%); max-height: min(80vh, 760px); display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); box-shadow: 0 18px 50px rgba(0,0,0,.28); }
      .mc-modal-head { display: flex; align-items: center; justify-content: space-between; }
      .mc-modal-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-path-row { display: flex; gap: 8px; }
      .mc-path-input { flex: 1; min-width: 0; }
      .mc-path-recursive { gap: 6px; }
      .mc-browse { flex: 1; min-height: 220px; max-height: 46vh; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 10px; padding: 4px; }
      .mc-browse.busy { opacity: .55; pointer-events: none; }
      .mc-browse-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
      .mc-browse-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); }
      .mc-browse-row.is-dir .mc-browse-name { font-weight: 600; }
      .mc-browse-icon { width: 14px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-browse-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-browse-empty { padding: 12px; }
      .mc-modal-foot { display: flex; align-items: center; gap: 8px; }
      .mc-task { display: flex; flex-direction: column; gap: 11px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); }
      .mc-task-head { display: flex; align-items: baseline; gap: 10px; }
      .mc-task-title { font-size: 14px; font-weight: 600; }
      .mc-task-count { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-task-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
      .mc-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; }
      .mc-seg button { padding: 5px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-seg button.on { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
      .mc-seg button:disabled { opacity: .45; cursor: default; }
      .mc-field { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-field .mc-select { padding: 5px 8px; font-size: 12.5px; }
      .mc-quality input[type='range'] { width: 120px; accent-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-batch-note { font-size: 12px; }
      .mc-summary { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-ptc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .mc-ptc-check { font-size: 12.5px; }
      .mc-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-ptc-copy { margin: 0; padding: 10px 12px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); font-size: 12px; line-height: 1.7; white-space: pre-line; max-width: 68ch; }
      .mc-task-foot { display: flex; align-items: center; gap: 10px; }
      .mc-batch-progress { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 5px; }
      .mc-batch-progress span { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-batch-result { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-btn-danger { color: var(--dsw-alias-state-error-primary, #d5483f); border-color: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-detail-head { display: flex; align-items: center; gap: 10px; }
      .mc-back { padding: 4px 8px 4px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-back:hover { color: var(--dsw-alias-label-primary, inherit); }
      .mc-detail-title { display: flex; flex-direction: column; gap: 3px; }
      .mc-detail-name { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
      .mc-recent { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-action-groups { display: flex; flex-direction: column; gap: 12px; }
      .mc-group { display: flex; flex-direction: column; gap: 8px; }
      .mc-group-title { margin-top: 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
      .mc-tile { display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color .15s, border-color .15s; }
      .mc-tile:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-tile.on { border-color: var(--dsw-static-deepseek-500, #4d6bfe); background: rgba(77, 107, 254, 0.06); }
      .mc-tile:disabled { opacity: .5; cursor: not-allowed; }
      .mc-tile-badge { flex: none; min-width: 38px; padding: 4px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; text-align: center; }
      .mc-tile-icon { flex: none; width: 18px; height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-tile-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .mc-tile-label { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-tile-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-empty-actions { padding: 24px 0; text-align: center; }
      .mc-panel { margin: 2px 0 0; }
      @media (max-width: 720px) {
        .mc-list-head { display: none; }
        .mc-item { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 10px; }
        .mc-item-name { flex: 1 1 55%; }
        .mc-kind, .mc-num, .mc-status { flex: 0 0 auto; }
        .mc-num { text-align: left; }
        .mc-row-actions { margin-left: auto; }
        .mc-row-error, .mc-rowbar { flex: 1 0 100%; }
        .mc-row-error { grid-column: auto; }
        .mc-task-row { gap: 10px; }
        .mc-task-foot { flex-wrap: wrap; }
        .mc-task-foot .mc-btn { flex: 1 1 100%; }
        .mc-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 460px) {
        .mc-grid { grid-template-columns: 1fr; }
      }
    `;

// React face of the panel. Eight lines of React is the whole seam: the
// element mounts once, owns its own DOM, and only receives the translator.
function Shell({ t }: { t: (key: string) => string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const panel = React.useRef<PanelElement | null>(null);
  React.useEffect(() => {
    const el = document.createElement('media-panel') as PanelElement;
    el.t = t; // set before connect so the first render is already translated
    panel.current = el; // firstElementChild is the <style>, not the panel
    ref.current!.appendChild(el);
    return () => {
      panel.current = null;
      el.remove();
    };
  }, []);
  React.useEffect(() => {
    if (panel.current) panel.current.t = t;
  }, [t]);
  // The stylesheet lives with the shell: Vue does not inject SFC styles when
  // the custom element uses light DOM.
  return h('div', { className: 'mc-host', ref }, h('style', null, CSS));
}

const plugin = {
  inject: ['slots', 'locale'],
  apply(ctx: PluginContext) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => {
      const offZh = ctx.locale.register(NS, 'zh', zh);
      const offEn = ctx.locale.register(NS, 'en', en);
      return () => {
        offZh();
        offEn();
      };
    });

    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('nav.label') },
        PanelIcon,
      ),
    );
    // The platform injects the translator when the slot declares its locale
    // namespace, and mints a fresh reference per language switch. The panel is
    // a Vue island outside the React tree, so that new reference is the only
    // thing that can make it re-render in the new language.
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Shell));

    // A compact button in the composer tool row (the "+" button's row): one
    // click puts the media instruction into the draft.
    ctx.effect(() => {
      // The loader also evaluates the bundle in a document-less sandbox (the
      // contract test); there is nothing to style there.
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.textContent = COMPOSER_CSS;
      document.head.appendChild(style);
      return () => style.remove();
    });
    ctx.slots.inject('conversation.input.left', () =>
      ctx.slots.register(
        { name: 'conversation.input.left', id: PANEL_ID + '-composer', order: 30, label: () => t('composer.label') },
        function ComposerEntry(props: { inputActions?: InputActions }) {
          return h(ComposerButton, { inputActions: props.inputActions, t });
        },
      ),
    );
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID + '-settings', order: 50, label: () => t('settings.label') },
        () => h(SettingsPage, { t }),
      ),
    );
  },
};

export const inject = plugin.inject;
export const apply = plugin.apply;
