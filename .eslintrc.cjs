module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  // whatsapp-connector is a wholly separate Node/TypeScript project (Gate 8)
  // with its own package.json/tsconfig -- it has no React dependency at all,
  // so linting it with react-hooks rules produces false positives (e.g.
  // Baileys' useMultiFileAuthState() matches the "use..." hook-naming
  // convention by coincidence but is not a React hook).
  ignorePatterns: ['dist', '.eslintrc.cjs', 'vite.config.ts', 'whatsapp-connector'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
}
