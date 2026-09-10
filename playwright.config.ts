import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start --workspace @grausvera/web -- --port 3100",
    env: {
      APP_ROLE: "web",
      DATABASE_URL: "postgresql://health:health@127.0.0.1:1/unavailable",
      LOG_LEVEL: "info",
      PUBLIC_CONTACT_EMAIL: "contact@example.com",
      PUBLIC_WHATSAPP_USERNAME: "example.brand",
    },
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
