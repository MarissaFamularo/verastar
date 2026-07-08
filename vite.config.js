import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Verastar runs entirely in the browser: BYOK Anthropic calls + public CORS-open
// data endpoints. No backend, no dev proxy — every fetch goes direct.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
