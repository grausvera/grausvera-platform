import { expect, test } from "@playwright/test";

test("serves the web entry", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("grausvera");
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
  await expect(page).toHaveTitle("Servicios | grausvera");
  await expect(
    page.getByText("Antes de proponer tecnología, tiempos o alcance", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("R1", { exact: true })).toHaveCount(0);

  await page.goto("/acerca");
  await expect(page).toHaveTitle("Acerca | grausvera");
  await expect(page.getByText("grausvera es una marca dedicada", { exact: false })).toBeVisible();
});

test("serves the approved project and controls unknown slugs", async ({ page }) => {
  await page.goto("/proyectos");
  await expect(page).toHaveTitle("Proyectos | grausvera");
  await page.getByRole("link", { name: "grausvera platform" }).click();
  await expect(page).toHaveTitle("grausvera platform | grausvera");
  await expect(page.getByText("En construcción", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Repositorio" })).toHaveAttribute(
    "href",
    "https://github.com/grausvera/grausvera-platform",
  );

  const response = await page.goto("/proyectos/no-existe");
  expect(response?.status()).toBe(404);
});

test("serves the approved publication and its valid project relationship", async ({ page }) => {
  await page.goto("/publicaciones");
  await expect(page).toHaveTitle("Publicaciones | grausvera");
  await page
    .getByRole("link", { name: "Construir la base antes de ampliar la plataforma" })
    .click();
  await expect(page).toHaveTitle("Construir la base antes de ampliar la plataforma | grausvera");
  await expect(page.getByRole("link", { name: "grausvera platform" })).toHaveAttribute(
    "href",
    "/proyectos/grausvera-platform",
  );

  const response = await page.goto("/publicaciones/no-existe");
  expect(response?.status()).toBe(404);
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
