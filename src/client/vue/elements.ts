// Vue components exposed to the React shell as plain custom elements.
//
// shadowRoot stays off: the panel ships its own CSS and inherits the shell's
// theme tokens either way, and light DOM keeps the existing selectors and the
// Playwright checks working unchanged.
import { defineCustomElement } from 'vue';
import App from '../App.vue';

const define = (name: string, component: typeof App) => {
  // Guarded: the artifact is also loaded in Node by test/client-bundle.
  if (typeof customElements === 'undefined' || customElements.get(name)) return;
  customElements.define(name, defineCustomElement(component, { shadowRoot: false }));
};

define('media-panel', App);
