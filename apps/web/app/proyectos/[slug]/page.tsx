import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContactSection } from "../../../components/contact-section";
import { MarkdownContent } from "../../../components/markdown-content";
import { ProjectStatus } from "../../../components/project-status";
import { getPublicProject } from "../../../lib/public-projects";

interface ProjectPageProps {
  params: Promise<{ slug: string }>;
}

const LINK_LABELS = {
  repository: "Repositorio",
  product: "Producto",
  demo: "Demostración",
  documentation: "Documentación",
} as const;

export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const project = await getPublicProject((await params).slug);

  return project
    ? { title: `${project.metadata.title} | grausvera`, description: project.metadata.summary }
    : { title: "Proyecto no encontrado | grausvera" };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const project = await getPublicProject((await params).slug);
  if (!project) notFound();

  const links = Object.entries(project.metadata.links);

  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="public-page">
        <header className="page-heading">
          <ProjectStatus status={project.metadata.projectStatus} />
          <h1>{project.metadata.title}</h1>
          <p className="lede">{project.metadata.summary}</p>
        </header>
        <MarkdownContent markdown={project.markdown} />
        {links.length > 0 ? (
          <section className="project-links" aria-labelledby="project-links-title">
            <h2 id="project-links-title">Explorar el proyecto</h2>
            <ul>
              {links.map(([kind, href]) => (
                <li key={kind}>
                  <a href={href}>{LINK_LABELS[kind as keyof typeof LINK_LABELS]}</a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <ContactSection />
      </article>
    </main>
  );
}
