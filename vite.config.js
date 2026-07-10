import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Verastar runs entirely in the browser: BYOK Anthropic calls + public CORS-open
// data endpoints. No backend, no dev proxy — every fetch goes direct.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // PORT is set by tooling (e.g. the preview harness) to avoid clashing with a dev server already on 5173.
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
