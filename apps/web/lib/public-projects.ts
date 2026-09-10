import {
  readPublishedContent,
  type PublicContentItem,
  type PublicContentMetadata,
} from "@grausvera/public-content";
import { join } from "node:path";

export type PublicProjectMetadata = Extract<PublicContentMetadata, { kind: "project" }>;
export type PublicProject = PublicContentItem & { metadata: PublicProjectMetadata };

function projectsDirectory(): string {
  return process.cwd().endsWith(join("apps", "web"))
    ? join(process.cwd(), "content", "projects")
    : join(process.cwd(), "apps", "web", "content", "projects");
}

export async function getPublicProjects(): Promise<PublicProject[]> {
  const content = await readPublishedContent(projectsDirectory());

  return content
    .filter((item): item is PublicProject => item.metadata.kind === "project")
    .sort((left, right) =>
      (right.metadata.publishedAt ?? "").localeCompare(left.metadata.publishedAt ?? ""),
    );
}

export async function getPublicProject(slug: string): Promise<PublicProject | undefined> {
  const projects = await getPublicProjects();
  return projects.find((project) => project.metadata.slug === slug);
}
