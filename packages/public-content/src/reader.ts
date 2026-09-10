import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { publicContentMetadataSchema, publicMarkdownSchema } from "./schemas.js";

export interface PublicContentItem {
  metadata: z.infer<typeof publicContentMetadataSchema>;
  markdown: string;
}

export async function readPublishedContent(directory: string): Promise<PublicContentItem[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const metadataFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".metadata.json"))
    .map((entry) => entry.name)
    .sort();
  const seenSlugs = new Set<string>();
  const published: PublicContentItem[] = [];

  for (const metadataFile of metadataFiles) {
    const basename = metadataFile.slice(0, -".metadata.json".length);
    const rawMetadata = await readFile(join(directory, metadataFile), "utf8");
    const metadata = publicContentMetadataSchema.parse(JSON.parse(rawMetadata));

    if (metadata.slug !== basename) {
      throw new Error(`Content slug does not match its filename: ${metadataFile}`);
    }

    if (seenSlugs.has(metadata.slug)) {
      throw new Error(`Duplicate public content slug: ${metadata.slug}`);
    }
    seenSlugs.add(metadata.slug);

    if (metadata.status !== "published") {
      continue;
    }

    const markdown = publicMarkdownSchema.parse(
      await readFile(join(directory, `${basename}.md`), "utf8"),
    );
    published.push({ metadata, markdown });
  }

  return published;
}
