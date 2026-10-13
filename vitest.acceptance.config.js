import { defineConfig } from 'vitest/config'

// The development acceptance suite for the replacement card system. Kept apart from `npm test`
// (vite.config.js excludes src/acceptance) so legacy regression expectations and the new
// specification never share a run or a pass/fail count.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/acceptance/**/*.acceptance.test.js'],
  },
})
