import { defineConfig } from "vitest/config";

// Pure-logic tests only. The DB layer uses an electron-ABI native module that
// cannot load under plain node, so those paths are verified by the manual
// integration script (scripts/offline-print-itest.mjs), not vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
