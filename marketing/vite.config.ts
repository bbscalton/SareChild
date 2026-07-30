import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The marketing site is the public face of the repo on GitHub Pages, which always
// serves a project (non-user/org) site under /<repo-name>/.
export default defineConfig({
  plugins: [react()],
  base: '/SareChild/',
})
