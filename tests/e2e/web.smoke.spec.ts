import { expect, test } from "@playwright/test";

test("serves the web entry", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Grausvera Platform");
  await expect(page.getByRole("main")).toHaveText("Grausvera Platform");
});
