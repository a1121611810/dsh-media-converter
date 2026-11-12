<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  allowedBridgeCall,
  bridgeReplyOf,
  isBridgeMessage,
  isExpectedSource,
  makeNonce,
  preambleOf,
  readJson,
} from '../lib.js';

// One sandboxed extension page. The iframe runs with an opaque origin (no
// parent DOM, cookies, or storage) and talks to the Host only through the
// bridge: postMessage → this listener validates source/token/path/body → the
// panel fetches with the session cookie → reply. Unmount tears the listener
// down and the nonce dies with it.
const props = defineProps<{ html: string }>();

const frameEl = ref<HTMLIFrameElement | null>(null);
const nonce = makeNonce();
const srcdoc = preambleOf(nonce) + props.html;

async function onMessage(event: MessageEvent): Promise<void> {
  const frame = frameEl.value;
  if (!frame || !isExpectedSource(event.source, frame.contentWindow)) return;
  if (!isBridgeMessage(event.data, nonce)) return;
  const call = allowedBridgeCall(event.data);
  if (!call.ok) {
    frame.contentWindow?.postMessage(bridgeReplyOf(event.data.id, { ok: false, error: call.error }), '*');
    return;
  }
  try {
    const resp = await fetch(call.path, {
      method: call.method,
      ...(call.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: call.body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await readJson<unknown>(resp);
    frame.contentWindow?.postMessage(bridgeReplyOf(event.data.id, { ok: true, status: resp.status, json }), '*');
  } catch (err) {
    frame.contentWindow?.postMessage(
      bridgeReplyOf(event.data.id, { ok: false, error: String((err as Error)?.message || err) }),
      '*',
    );
  }
}

onMounted(() => {
  // srcdoc is assigned here, not via template binding, to be explicit that
  // the author HTML lands in a sandboxed, cookie-less document.
  if (frameEl.value) frameEl.value.srcdoc = srcdoc;
  window.addEventListener('message', onMessage);
});
onUnmounted(() => window.removeEventListener('message', onMessage));
</script>

<template>
  <iframe ref="frameEl" class="mc-ext-frame" sandbox="allow-scripts" title="extension page"></iframe>
</template>
