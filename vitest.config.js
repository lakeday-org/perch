import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{js,ts}'],
    exclude: ['**/node_modules/**', 'dist/**', '.perch/**'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
