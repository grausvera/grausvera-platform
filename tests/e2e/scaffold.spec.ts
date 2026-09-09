import { expect, test } from "@playwright/test";

test("serves the web scaffold", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("Grausvera Platform");
  await expect(page.getByRole("main")).toHaveText("Grausvera Platform");
});
