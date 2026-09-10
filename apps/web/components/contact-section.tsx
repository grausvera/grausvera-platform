import { loadGeneralCta, type PublicCtaContext } from "@grausvera/public-content";
import { PublicCta } from "./public-cta";

export function ContactSection({ context }: { context?: PublicCtaContext }) {
  const cta = loadGeneralCta(process.env, context);

  return (
    <section aria-labelledby="contact-title" className="contact-section">
      <p className="eyebrow">Siguiente paso</p>
      <h2 id="contact-title">Conversemos sobre lo que necesitas construir.</h2>
      {cta ? (
        <PublicCta {...cta} />
      ) : (
        <p className="contact-unavailable">
          Los canales públicos de contacto están en preparación.
        </p>
      )}
    </section>
  );
}
