import type { PublicContentItem } from "@grausvera/public-content";
import { ContactSection } from "./contact-section";
import { MarkdownContent } from "./markdown-content";

export function PublicPage({ content }: { content: PublicContentItem }) {
  const context = {
    kind: content.metadata.slug === "servicios" ? "service" : "page",
    slug: content.metadata.slug,
    title: content.metadata.title,
  } as const;

  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="public-page">
        <header className="page-heading">
          <p className="eyebrow">grausvera</p>
          <h1>{content.metadata.title}</h1>
          <p className="lede">{content.metadata.summary}</p>
        </header>
        <MarkdownContent markdown={content.markdown} />
        <ContactSection context={context} />
      </article>
    </main>
  );
}
