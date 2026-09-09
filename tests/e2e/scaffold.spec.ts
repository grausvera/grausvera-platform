import { expect, test } from "@playwright/test";

test("serves the web scaffold", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("Grausvera");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Construimos productos digitales donde cada detalle tiene una razón.",
    }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Navegación principal" });
  await expect(navigation.getByRole("link")).toHaveCount(3);
  await expect(navigation.getByRole("link", { name: "Servicios" })).toBeVisible();
});
