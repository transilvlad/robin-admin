import tsParser from '../server/node_modules/@typescript-eslint/parser/dist/index.js';

const reactHooksPlugin = {
  rules: {
    'exhaustive-deps': {
      meta: {
        type: 'suggestion',
        schema: [],
      },
      create() {
        return {};
      },
    },
  },
};

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {},
  },
];
