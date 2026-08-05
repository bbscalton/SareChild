import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The marketing site is the public face of the repo on GitHub Pages, which always
// serves a project (non-user/org) site under /<repo-name>/. It also ships the
// standalone TCD ops console as a second page (tcd.html) built from the same
// project so https://bbscalton.github.io/SareChild/tcd.html works without a
// Firebase Hosting dependency.
export default defineConfig({
  plugins: [react()],
  base: '/SareChild/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tcd: resolve(__dirname, 'tcd.html'),
        reseller: resolve(__dirname, 'reseller.html'),
      },
    },
  },
})
