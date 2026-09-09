import { expect, test } from "@playwright/test";

test("reports an unavailable database without exposing its error", async ({ request }) => {
  const response = await request.get("/api/health");
  const body = await response.json();

  expect(response.status()).toBe(503);
  expect(body).toMatchObject({ status: "unhealthy" });
  expect(body.correlationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  expect(JSON.stringify(body)).not.toContain("local-password");
});
