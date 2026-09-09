import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicPage } from "../../components/public-page";
import { getPublicPage } from "../../lib/public-pages";

export const metadata: Metadata = {
  title: "Servicios | Grausvera",
  description: "Productos digitales a medida, construidos desde el problema y el contexto.",
};

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const content = await getPublicPage("servicios");
  if (!content) notFound();

  return <PublicPage content={content} />;
}
