import type { PublicProjectMetadata } from "../lib/public-projects";

const STATUS_LABELS: Record<PublicProjectMetadata["projectStatus"], string> = {
  building: "En construcción",
  available: "Disponible",
  completed: "Caso completado",
  maintained: "Mantenido",
  archived: "Archivado",
};

export function ProjectStatus({ status }: { status: PublicProjectMetadata["projectStatus"] }) {
  return <p className="project-status">{STATUS_LABELS[status]}</p>;
}
