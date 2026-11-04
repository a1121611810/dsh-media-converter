// Builds the browser half into the single file the DSH loader fetches:
// /plugins/dsh-media-converter/client.js. It must be an IIFE wrapped in the
// loader handshake, and React must come from the app's module table rather
// than being bundled.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // lib mode keeps process.env.NODE_ENV intact; without this the bundle carries
  // Vue's dev-only code (and touches document at load, which breaks the Node
  // contract test and wastes ~60 kB).
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    target: 'es2022',
    // Build into dist/ (Vite refuses to write into the project root); the npm
    // script copies client.js next to index.js, which is the path dsh.client
    // resolves.
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'oxc',
    sourcemap: true,
    lib: {
      entry: 'src/client/index.js',
      formats: ['iife'],
      name: '__media',
      fileName: () => 'client.js',
    },
    rollupOptions: {
      output: {
        // The factory body cannot see the loader's `require` argument from
        // inside the IIFE, so React is parked on a global the bundle reads.
        banner: "window.__ModuleLoader__.load({id:'dsh-media-converter',factory(require){globalThis.__dshReact=require('react');",
        footer: 'return __media;}})',
      },
    },
  },
});
