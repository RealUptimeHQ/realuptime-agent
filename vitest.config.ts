import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The mutation tests in buffer.test.ts and check-http.test.ts rewrite a
    // module-level constant and restore it in a `finally`. That is only safe
    // when nothing else is running against the same module instance, so the
    // whole package runs single-file-at-a-time rather than relying on every
    // future test author remembering to opt out.
    fileParallelism: false,
  },
});
