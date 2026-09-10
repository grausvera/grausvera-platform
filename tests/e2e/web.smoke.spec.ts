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
  const servicesHref = await page
    .getByRole("link", { name: "Conversar por WhatsApp" })
    .getAttribute("href");
  expect(new URL(servicesHref ?? "").searchParams.get("text")).toBe(
    "Hola, conocí los servicios de grausvera y quiero conversar sobre un proyecto digital.",
  );

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
  const projectHref = await page
    .getByRole("link", { name: "Conversar por WhatsApp" })
    .getAttribute("href");
  expect(new URL(projectHref ?? "").searchParams.get("text")).toBe(
    "Hola, vi el proyecto «grausvera platform» en grausvera y quiero conversar sobre algo similar.",
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
  const publicationHref = await page
    .getByRole("link", { name: "Conversar por WhatsApp" })
    .getAttribute("href");
  expect(new URL(publicationHref ?? "").searchParams.get("text")).toBe(
    "Hola, leí «Construir la base antes de ampliar la plataforma» en grausvera y quiero conversar sobre un proyecto digital.",
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

test("keeps every public route indexable, linked, and free of internal data", async ({ page }) => {
  const routes = [
    "/",
    "/servicios",
    "/acerca",
    "/proyectos",
    "/proyectos/grausvera-platform",
    "/publicaciones",
    "/publicaciones/construir-la-base",
  ];

  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /\S+/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      "content",
      "grausvera",
    );

    const html = await page.content();
    expect(html).not.toContain("private-token");
    expect(html).not.toContain("local-password");
    expect(html).not.toContain("SRC-GP-");

    for (const href of await page
      .locator("a")
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean),
      )) {
      expect(href, `${route}: ${href}`).toMatch(/^(\/|#|https:\/\/|mailto:)/);
      if (href?.startsWith("/")) {
        expect(
          (await page.request.get(new URL(href, page.url()).toString())).status(),
        ).toBeLessThan(400);
      }
    }
  }
});

test("keeps text contrast and layout usable at mobile zoom", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/proyectos/grausvera-platform");

  const contrastRatios = await page.locator("body").evaluate(() => {
    const luminance = (color: string) => {
      const channels = color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const background = luminance(getComputedStyle(document.documentElement).backgroundColor);

    return ["h1", ".lede", ".project-status", ".prose"].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing contrast target: ${selector}`);
      const foreground = luminance(getComputedStyle(element).color);
      return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
    });
  });
  expect(Math.min(...contrastRatios)).toBeGreaterThanOrEqual(4.5);

  await page.locator("html").evaluate((element) => {
    element.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
});

test("observes a local mobile LCP within the public target", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "__lastLcp", 0);
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries())
        Reflect.set(globalThis, "__lastLcp", entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.waitForTimeout(100);

  const lcp = await page.evaluate(() => Reflect.get(globalThis, "__lastLcp") as number);
  expect(lcp).toBeGreaterThan(0);
  expect(lcp).toBeLessThanOrEqual(2_500);
});
