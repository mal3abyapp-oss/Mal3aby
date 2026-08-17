module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  // whatsapp-connector is a separate, non-React Node/TypeScript service
  // (its own package.json/tsconfig.json/node_modules) -- the root
  // React-focused config (react-hooks/rules-of-hooks etc.) does not
  // apply there and produces false positives, e.g. flagging Baileys'
  // useMultiFileAuthState() as a misused React Hook. Excluded rather
  // than given its own eslint config, since it is not part of this
  // app's lint/build/deploy pipeline at all.
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
