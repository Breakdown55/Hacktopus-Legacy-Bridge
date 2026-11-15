import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { hookTimeout: 120_000, testTimeout: 60_000, include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'server/**/*.test.ts', 'workers/**/*.test.ts'] } });
