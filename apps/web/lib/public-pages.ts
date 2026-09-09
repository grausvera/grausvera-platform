import { readPublishedContent, type PublicContentItem } from "@grausvera/public-content";
import { join } from "node:path";

export async function getPublicPage(slug: string): Promise<PublicContentItem | undefined> {
  const contentDirectory = process.cwd().endsWith(join("apps", "web"))
    ? join(process.cwd(), "content", "pages")
    : join(process.cwd(), "apps", "web", "content", "pages");
  const pages = await readPublishedContent(contentDirectory);

  return pages.find((page) => page.metadata.kind === "page" && page.metadata.slug === slug);
}
