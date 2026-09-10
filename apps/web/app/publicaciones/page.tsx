import type { Metadata } from "next";
import Link from "next/link";
import { PublicationDate } from "../../components/publication-date";
import { getPublicPublications } from "../../lib/public-publications";

export const metadata: Metadata = {
  title: "Publicaciones | grausvera",
  description: "Aprendizajes, decisiones y novedades publicadas por grausvera.",
};

export default async function PublicationsPage() {
  const publications = await getPublicPublications();

  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="project-index">
        <header className="page-heading">
          <p className="eyebrow">Ideas y avances</p>
          <h1>Publicaciones</h1>
          <p className="lede">
            Decisiones, aprendizajes y avances que vale la pena compartir con contexto.
          </p>
        </header>

        {publications.length === 0 ? (
          <section className="empty-state" aria-labelledby="empty-publications-title">
            <h2 id="empty-publications-title">Todavía no hay publicaciones disponibles.</h2>
            <p>La primera pieza aparecerá aquí después de su revisión editorial.</p>
          </section>
        ) : (
          <ul className="project-list">
            {publications.map((publication) => (
              <li className="project-card" key={publication.metadata.slug}>
                <p className="project-status">
                  <PublicationDate value={publication.metadata.publishedAt} />
                </p>
                <h2>
                  <Link href={`/publicaciones/${publication.metadata.slug}`}>
                    {publication.metadata.title}
                  </Link>
                </h2>
                <p>{publication.metadata.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </article>
    </main>
  );
}
