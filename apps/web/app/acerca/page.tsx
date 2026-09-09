import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicPage } from "../../components/public-page";
import { getPublicPage } from "../../lib/public-pages";

export const metadata: Metadata = {
  title: "Acerca | Grausvera",
  description: "Diseño y funcionalidad reciben el mismo cuidado en Grausvera.",
};

export const dynamic = "force-dynamic";

export default async function AboutPage() {
  const content = await getPublicPage("acerca");
  if (!content) notFound();

  return <PublicPage content={content} />;
}
