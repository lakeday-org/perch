import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['.benchmarks/reviewbench/*.test.mjs'] } });
