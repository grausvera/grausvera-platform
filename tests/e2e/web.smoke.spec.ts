import { expect, test } from "@playwright/test";

test("serves the web entry", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Grausvera");
  await expect(
    page.getByText(
      "Convertimos necesidades reales en experiencias claras, funcionales y cuidadas, desde la idea hasta una primera versión útil.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversar por WhatsApp" })).toHaveAttribute(
    "href",
    /wa\.me\/example\.brand\?text=/,
  );
  await expect(page.getByRole("link", { name: "Escribir por correo" })).toHaveAttribute(
    "href",
    "mailto:contact@example.com",
  );
});

test("serves the approved services and brand-only about pages", async ({ page }) => {
  await page.goto("/servicios");
  await expect(page).toHaveTitle("Servicios | Grausvera");
  await expect(
    page.getByText("Antes de proponer tecnología, tiempos o alcance", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("R1", { exact: true })).toHaveCount(0);

  await page.goto("/acerca");
  await expect(page).toHaveTitle("Acerca | Grausvera");
  await expect(page.getByText("Grausvera es una marca dedicada", { exact: false })).toBeVisible();
});

test("offers keyboard access to the main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");

  const skipLink = page.getByRole("link", { name: "Saltar al contenido" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("keeps the public shell within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
