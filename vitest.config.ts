import { defineConfig } from "vitest/config";

// The plugin's tests; ui/ has its own (node --test, run by npm test).
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
