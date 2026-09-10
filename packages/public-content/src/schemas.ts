import { z } from "zod";

export const PUBLIC_ROUTES = [
  "/",
  "/servicios",
  "/acerca",
  "/proyectos",
  "/proyectos/[slug]",
  "/publicaciones",
  "/publicaciones/[slug]",
] as const;

export const publicRouteSchema = z.enum(PUBLIC_ROUTES);

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sourceIdSchema = z.string().regex(/^SRC-GP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/);
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === "https:", {
  message: "Public links must use HTTPS",
});

const commonMetadataSchema = z
  .object({
    slug: slugSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(240),
    status: z.enum(["draft", "review", "published"]),
    sourceIds: z.array(sourceIdSchema).default([]),
    reviewedAt: z.iso.datetime().optional(),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict();

function requirePublicationEvidence(
  value: z.infer<typeof commonMetadataSchema>,
  context: z.RefinementCtx,
) {
  if (value.status !== "published") return;

  if (value.sourceIds.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Published content requires at least one registered source",
      path: ["sourceIds"],
    });
  }

  for (const field of ["reviewedAt", "publishedAt"] as const) {
    if (!value[field]) {
      context.addIssue({
        code: "custom",
        message: `Published content requires ${field}`,
        path: [field],
      });
    }
  }
}

export const pageMetadataSchema = commonMetadataSchema
  .extend({ kind: z.literal("page") })
  .superRefine(requirePublicationEvidence);

export const projectMetadataSchema = commonMetadataSchema
  .extend({
    kind: z.literal("project"),
    projectStatus: z.enum(["building", "available", "completed", "maintained", "archived"]),
    links: z
      .object({
        repository: httpsUrlSchema.optional(),
        product: httpsUrlSchema.optional(),
        demo: httpsUrlSchema.optional(),
        documentation: httpsUrlSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .superRefine(requirePublicationEvidence);

export const publicationMetadataSchema = commonMetadataSchema
  .extend({
    kind: z.literal("publication"),
    relatedProjectSlugs: z.array(slugSchema).default([]),
    relatedServiceSlugs: z.array(slugSchema).default([]),
  })
  .superRefine(requirePublicationEvidence);

export const publicContentMetadataSchema = z.union([
  pageMetadataSchema,
  projectMetadataSchema,
  publicationMetadataSchema,
]);

export const publicMarkdownSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), {
    message: "Raw HTML is not allowed in public Markdown",
  })
  .refine(
    (value) =>
      [...value.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].every(
        ([, destination]) =>
          destination?.startsWith("/") ||
          destination?.startsWith("#") ||
          destination?.startsWith("https://"),
      ),
    {
      message: "Markdown links must be internal, fragments, or HTTPS",
    },
  );

export const generalCtaSchema = z
  .object({
    whatsappUsername: z.string().regex(/^[A-Za-z0-9._]{3,30}$/),
    email: z.email(),
    message: z.string().trim().min(1).max(280),
  })
  .strict();

export const GENERAL_WHATSAPP_MESSAGE =
  "Hola, conocí grausvera y quiero conversar sobre un proyecto digital.";

export function loadGeneralCta(source: Record<string, string | undefined>): GeneralCta | undefined {
  const result = generalCtaSchema.safeParse({
    whatsappUsername: source.PUBLIC_WHATSAPP_USERNAME,
    email: source.PUBLIC_CONTACT_EMAIL,
    message: GENERAL_WHATSAPP_MESSAGE,
  });

  return result.success ? result.data : undefined;
}

export type GeneralCta = z.infer<typeof generalCtaSchema>;
export type PublicContentMetadata = z.infer<typeof publicContentMetadataSchema>;
export type PublicRoute = z.infer<typeof publicRouteSchema>;

export function buildWhatsAppUrl(input: GeneralCta): URL {
  const cta = generalCtaSchema.parse(input);
  const url = new URL(`https://wa.me/${cta.whatsappUsername}`);
  url.searchParams.set("text", cta.message);
  return url;
}
