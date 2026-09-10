import { notFound } from "next/navigation";
import { PublicPage } from "../components/public-page";
import { getPublicPage } from "../lib/public-pages";

export const dynamic = "force-dynamic";

export default async function Home() {
  const content = await getPublicPage("inicio");
  if (!content) notFound();

  return <PublicPage content={content} />;
}
