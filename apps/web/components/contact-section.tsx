import { loadGeneralCta } from "@grausvera/public-content";
import { PublicCta } from "./public-cta";

export function ContactSection() {
  const cta = loadGeneralCta(process.env);

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
