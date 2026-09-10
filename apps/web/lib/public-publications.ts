import {
  readPublishedContent,
  type PublicContentItem,
  type PublicContentMetadata,
} from "@grausvera/public-content";
import { join } from "node:path";

export type PublicPublicationMetadata = Extract<PublicContentMetadata, { kind: "publication" }>;
export type PublicPublication = PublicContentItem & { metadata: PublicPublicationMetadata };

function publicationsDirectory(): string {
  return process.cwd().endsWith(join("apps", "web"))
    ? join(process.cwd(), "content", "publications")
    : join(process.cwd(), "apps", "web", "content", "publications");
}

export async function getPublicPublications(): Promise<PublicPublication[]> {
  const content = await readPublishedContent(publicationsDirectory());

  return content
    .filter((item): item is PublicPublication => item.metadata.kind === "publication")
    .sort((left, right) =>
      (right.metadata.publishedAt ?? "").localeCompare(left.metadata.publishedAt ?? ""),
    );
}

export async function getPublicPublication(slug: string): Promise<PublicPublication | undefined> {
  const publications = await getPublicPublications();
  return publications.find((publication) => publication.metadata.slug === slug);
}
