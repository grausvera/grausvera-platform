import type { Metadata } from "next";
import Link from "next/link";
import { ProjectStatus } from "../../components/project-status";
import { getPublicProjects } from "../../lib/public-projects";

export const metadata: Metadata = {
  title: "Proyectos | grausvera",
  description: "Proyectos y productos digitales publicados por grausvera.",
};

export default async function ProjectsPage() {
  const projects = await getPublicProjects();

  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="project-index">
        <header className="page-heading">
          <p className="eyebrow">Evidencia</p>
          <h1>Proyectos</h1>
          <p className="lede">
            Trabajo real de grausvera, presentado con su estado y contexto público disponible.
          </p>
        </header>

        {projects.length === 0 ? (
          <section className="empty-state" aria-labelledby="empty-projects-title">
            <h2 id="empty-projects-title">Todavía no hay proyectos publicados.</h2>
            <p>
              Esta sección mostrará únicamente trabajo real revisado. No usamos ejemplos ficticios
              para completar el portafolio.
            </p>
          </section>
        ) : (
          <ul className="project-list">
            {projects.map((project) => (
              <li className="project-card" key={project.metadata.slug}>
                <ProjectStatus status={project.metadata.projectStatus} />
                <h2>
                  <Link href={`/proyectos/${project.metadata.slug}`}>{project.metadata.title}</Link>
                </h2>
                <p>{project.metadata.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </article>
    </main>
  );
}
