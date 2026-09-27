import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", outputDir: "../../outputs/desktop-tests", fullyParallel: false,
  use: { reducedMotion: "reduce", baseURL: "http://127.0.0.1:1420", viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  webServer: { command: "npm run dev:web", url: "http://127.0.0.1:1420", reuseExistingServer: !process.env.CI },
});
