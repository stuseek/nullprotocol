module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'build/**'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        module: 'writable',
        require: 'readonly',
        global: 'writable',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        jest: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-console': ['warn', {
        allow: ['warn', 'error']
      }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-extra-semi': 'error',
      'no-func-assign': 'error',
      'no-irregular-whitespace': 'error',
      'no-unexpected-multiline': 'error',
      'curly': ['error', 'all'],
      'dot-notation': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-multi-spaces': 'error',
      'no-redeclare': 'error',
      'no-with': 'error',
      'brace-style': ['error', '1tbs', { allowSingleLine: true }],
      'comma-dangle': ['error', 'never'],
      'comma-spacing': 'error',
      'comma-style': 'error',
      'func-call-spacing': 'error',
      'indent': 'off',
      'key-spacing': 'error',
      'keyword-spacing': 'error',
      'no-trailing-spaces': 'error',
      'object-curly-spacing': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'semi': ['error', 'always'],
      'semi-spacing': 'error',
      'space-before-blocks': 'error',
      'space-before-function-paren': ['error', {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always'
      }],
      'space-in-parens': 'error',
      'space-infix-ops': 'error',
      'arrow-spacing': 'error',
      'no-confusing-arrow': 'error',
      'no-const-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-imports': 'error',
      'no-new-symbol': 'error',
      'no-this-before-super': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'template-curly-spacing': 'error'
    }
  },
  {
    files: ['examples/**/*.js'],
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['**/*.test.js', '**/__tests__/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off'
    }
  }
];
