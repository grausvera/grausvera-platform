import type { PublicContentItem } from "@grausvera/public-content";
import { ContactSection } from "./contact-section";
import { MarkdownContent } from "./markdown-content";

export function PublicPage({ content }: { content: PublicContentItem }) {
  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="public-page">
        <header className="page-heading">
          <p className="eyebrow">Grausvera</p>
          <h1>{content.metadata.title}</h1>
          <p className="lede">{content.metadata.summary}</p>
        </header>
        <MarkdownContent markdown={content.markdown} />
        <ContactSection />
      </article>
    </main>
  );
}
