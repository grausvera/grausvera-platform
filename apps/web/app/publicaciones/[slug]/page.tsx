import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContactSection } from "../../../components/contact-section";
import { MarkdownContent } from "../../../components/markdown-content";
import { PublicationDate } from "../../../components/publication-date";
import { getPublicProjects } from "../../../lib/public-projects";
import { getPublicPublication } from "../../../lib/public-publications";

interface PublicationPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PublicationPageProps): Promise<Metadata> {
  const publication = await getPublicPublication((await params).slug);

  return publication
    ? {
        title: `${publication.metadata.title} | grausvera`,
        description: publication.metadata.summary,
        openGraph: {
          type: "article",
          locale: "es_PE",
          siteName: "grausvera",
          title: publication.metadata.title,
          description: publication.metadata.summary,
          publishedTime: publication.metadata.publishedAt,
        },
      }
    : { title: "Publicación no encontrada | grausvera" };
}

export default async function PublicationPage({ params }: PublicationPageProps) {
  const publication = await getPublicPublication((await params).slug);
  if (!publication) notFound();

  const publishedProjects = await getPublicProjects();
  const relatedProjects = publishedProjects.filter((project) =>
    publication.metadata.relatedProjectSlugs.includes(project.metadata.slug),
  );

  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="public-page">
        <header className="page-heading">
          <p className="project-status">
            <PublicationDate value={publication.metadata.publishedAt} />
          </p>
          <h1>{publication.metadata.title}</h1>
          <p className="lede">{publication.metadata.summary}</p>
        </header>
        <MarkdownContent markdown={publication.markdown} />
        {relatedProjects.length > 0 ? (
          <section className="project-links" aria-labelledby="related-projects-title">
            <h2 id="related-projects-title">Proyecto relacionado</h2>
            <ul>
              {relatedProjects.map((project) => (
                <li key={project.metadata.slug}>
                  <Link href={`/proyectos/${project.metadata.slug}`}>{project.metadata.title}</Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <ContactSection
          context={{
            kind: "publication",
            slug: publication.metadata.slug,
            title: publication.metadata.title,
          }}
        />
      </article>
    </main>
  );
}
