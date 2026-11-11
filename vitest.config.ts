import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    // Ignored working copies carry their own test files and stale paths. They
    // are not part of this repository's suite; including them buried real
    // failures under dozens of "Cannot find package" errors.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.agent-worktrees/**",
      "**/.agent-tools/**",
    ],
  },
});
