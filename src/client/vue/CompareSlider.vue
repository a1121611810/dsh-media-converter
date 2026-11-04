<script setup>
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  before: { type: String, required: true },
  after: { type: String, default: '' },
  leftLabel: { type: String, default: '' },
  rightLabel: { type: String, default: '' },
});

const position = ref(50);
const dragging = ref(false);
const frame = ref(null);

function moveTo(clientX) {
  const rect = frame.value && frame.value.getBoundingClientRect();
  if (!rect || !rect.width) return;
  position.value = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
}

function onDown(event) {
  event.preventDefault();
  dragging.value = true;
  moveTo(event.clientX);
}

// The pointer leaves the frame while dragging, so these listen on the window.
function onMove(event) {
  if (dragging.value) moveTo(event.clientX);
}

function onUp() {
  dragging.value = false;
}

function onKey(event) {
  if (event.key === 'ArrowLeft') position.value = Math.max(0, position.value - 2);
  if (event.key === 'ArrowRight') position.value = Math.min(100, position.value + 2);
}

window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
});
</script>

<template>
  <div
    ref="frame"
    class="mc-slider"
    role="slider"
    tabindex="0"
    :aria-label="props.leftLabel + ' / ' + props.rightLabel"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="Math.round(position)"
    @pointerdown="onDown"
    @keydown="onKey"
  >
    <img :src="props.after" alt="" draggable="false" decoding="async" />
    <div class="mc-slider-clip" :style="{ clipPath: 'inset(0 ' + (100 - position) + '% 0 0)' }">
      <img :src="props.before" alt="" draggable="false" decoding="async" />
    </div>
    <div class="mc-slider-handle" :style="{ left: position + '%' }"></div>
    <span class="mc-slider-tag left">{{ props.leftLabel }}</span>
    <span class="mc-slider-tag right">{{ props.rightLabel }}</span>
  </div>
</template>
