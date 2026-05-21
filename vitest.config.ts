import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/results.json' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './test-results/coverage',
    },
  },
});
