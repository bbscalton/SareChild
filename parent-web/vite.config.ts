import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// GitHub Pages serves this app from /SareChild/, while Firebase Hosting serves it from
// the domain root. `vite build` always sets NODE_ENV=production, so that alone can't tell
// the two targets apart — the GitHub Pages workflow sets GITHUB_PAGES=true to opt into the
// sub-path base; Firebase Hosting builds (local or CI) default to root.
const base = process.env.GITHUB_PAGES === 'true' ? '/SareChild/' : '/'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    alias: {
      '@marketing-tcd': resolve(__dirname, '../marketing/src/tcd'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tcd: resolve(__dirname, 'tcd.html'),
      },
    },
  },
})
