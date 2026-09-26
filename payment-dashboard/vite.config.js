import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // The generated contract bindings (packages/types) import "buffer"
      // directly; resolving it to the real npm package (hoisted by npm)
      // avoids the plugin's alias shim, which does not resolve for files
      // outside the dashboard root.
      exclude: ['buffer'],
    }),
  ],
  resolve: {
    dedupe: [
      // The bindings package lives outside the dashboard root (packages/types),
      // so its own `@stellar/stellar-sdk` / `buffer` imports would otherwise
      // resolve against the repo root. Dedupe forces every importer, including
      // the linked bindings, to use the dashboard's installed copies.
      '@stellar/stellar-sdk',
      'buffer',
    ],
  },
  define: {
    global: 'globalThis',
  },
  build: {
    chunkSizeWarningLimit: 1100,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})