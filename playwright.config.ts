import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4173/Flashcards/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    channel: process.env.PW_CHROME === "1" ? "chrome" : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "npm run preview -- --base /Flashcards/ --port 4173",
    url: "http://127.0.0.1:4173/Flashcards/",
    reuseExistingServer: !process.env.CI,
  },
});
