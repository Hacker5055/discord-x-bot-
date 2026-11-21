// Keep unresolved names out of production and regression-test code.
export default [{
  files: ['src/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: Object.fromEntries([
      'process', 'console', 'Buffer', 'fetch', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'AbortController', 'AbortSignal', 'URL',
      'URLSearchParams', 'performance', 'Response', 'Request', 'Headers',
      'TextDecoder', 'TextEncoder', 'structuredClone', 'setImmediate',
    ].map((name) => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error' },
}];
