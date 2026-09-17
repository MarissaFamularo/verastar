import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'design/**', 'public/server/**']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaVersion: 'latest', ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    rules: { 'react-refresh/only-export-components': ['warn', { allowConstantExport: true }], 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }] },
  },
])
