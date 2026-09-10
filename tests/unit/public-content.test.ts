import { describe, expect, it } from "vitest";
import {
  buildContextualWhatsAppMessage,
  buildWhatsAppUrl,
  GENERAL_WHATSAPP_MESSAGE,
  generalCtaSchema,
  loadGeneralCta,
  projectMetadataSchema,
  publicContentMetadataSchema,
  publicCtaContextSchema,
  publicMarkdownSchema,
  publicRouteSchema,
  readPublishedContent,
} from "../../packages/public-content/src";

const publishedPage = {
  kind: "page",
  slug: "servicios",
  title: "Servicios",
  summary: "Alcance público revisado.",
  status: "published",
  sourceIds: ["SRC-GP-R1-SCOPE"],
  reviewedAt: "2026-09-09T00:00:00.000Z",
  publishedAt: "2026-09-09T00:00:00.000Z",
} as const;

describe("public content contracts", () => {
  it("accepts only the routes planned for the R1 public experience", () => {
    expect(publicRouteSchema.parse("/proyectos/[slug]")).toBe("/proyectos/[slug]");
    expect(() => publicRouteSchema.parse("/clientes")).toThrow();
  });

  it("requires sources and review dates before content can be published", () => {
    expect(publicContentMetadataSchema.parse(publishedPage)).toMatchObject(publishedPage);
    expect(() =>
      publicContentMetadataSchema.parse({
        ...publishedPage,
        sourceIds: [],
        reviewedAt: undefined,
      }),
    ).toThrow();

    expect(
      publicContentMetadataSchema.parse({
        kind: "page",
        slug: "borrador",
        title: "Borrador",
        summary: "Todavía no es público.",
        status: "draft",
      }),
    ).toMatchObject({ status: "draft", sourceIds: [] });
  });

  it("rejects unsafe project links", () => {
    expect(() =>
      projectMetadataSchema.parse({
        ...publishedPage,
        kind: "project",
        projectStatus: "building",
        links: { repository: "http://example.com/project" },
      }),
    ).toThrow();
  });

  it("builds a reviewable WhatsApp destination without accepting campaign data", () => {
    const cta = {
      whatsappUsername: "example.brand",
      email: "contact@example.com",
      message: "Hola, quiero conversar sobre un proyecto web.",
    };

    const url = buildWhatsAppUrl(cta);
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/example.brand");
    expect(url.searchParams.get("text")).toBe(cta.message);
    expect(() => generalCtaSchema.parse({ ...cta, campaign: "private-token" })).toThrow();
  });

  it("loads contact destinations from runtime configuration without versioning them", () => {
    expect(
      loadGeneralCta({
        PUBLIC_CONTACT_EMAIL: "contact@example.com",
        PUBLIC_WHATSAPP_USERNAME: "example.brand",
      }),
    ).toEqual({
      email: "contact@example.com",
      whatsappUsername: "example.brand",
      message: GENERAL_WHATSAPP_MESSAGE,
    });
    expect(loadGeneralCta({})).toBeUndefined();
  });

  it("builds exact messages from reviewed public context only", () => {
    expect(
      buildContextualWhatsAppMessage({
        kind: "project",
        slug: "demo-publica",
        title: "Demo pública",
      }),
    ).toBe(
      "Hola, vi el proyecto «Demo pública» en grausvera y quiero conversar sobre algo similar.",
    );
    expect(
      buildContextualWhatsAppMessage({
        kind: "publication",
        slug: "nota-publica",
        title: "Una nota pública",
      }),
    ).toBe(
      "Hola, leí «Una nota pública» en grausvera y quiero conversar sobre un proyecto digital.",
    );
    expect(() =>
      publicCtaContextSchema.parse({
        kind: "project",
        slug: "demo-publica",
        title: "Demo pública",
        token: "private-token",
      }),
    ).toThrow();
  });

  it("reads only reviewed and published Markdown from paired metadata", async () => {
    const content = await readPublishedContent("tests/fixtures/public-content");

    expect(content).toHaveLength(1);
    expect(content[0]?.metadata).toMatchObject({ slug: "inicio", status: "published" });
    expect(content[0]?.markdown).toContain("Contenido sintético");
  });

  it("serves only published project fixtures with reviewed HTTPS links", async () => {
    const projects = await readPublishedContent("tests/fixtures/public-projects");

    expect(projects).toHaveLength(1);
    expect(projects[0]?.metadata).toMatchObject({
      kind: "project",
      slug: "demo-sintetica",
      projectStatus: "building",
      links: { documentation: "https://example.com/docs" },
    });
    expect(projects[0]?.markdown).toContain("exclusivamente sintético");
  });

  it("serves only published publication fixtures with declared relationships", async () => {
    const publications = await readPublishedContent("tests/fixtures/public-publications");

    expect(publications).toHaveLength(1);
    expect(publications[0]?.metadata).toMatchObject({
      kind: "publication",
      slug: "nota-sintetica",
      relatedProjectSlugs: ["demo-sintetica"],
    });
    expect(publications[0]?.markdown).toContain("publicación sintética");
  });

  it("rejects raw HTML and unsafe Markdown destinations", () => {
    expect(() => publicMarkdownSchema.parse("<script>alert('unsafe')</script>")).toThrow();
    expect(() => publicMarkdownSchema.parse("[destino](http://example.com)")).toThrow();
    expect(publicMarkdownSchema.parse("[destino seguro](https://example.com)")).toContain(
      "destino seguro",
    );
  });
});
