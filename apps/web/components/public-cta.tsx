import { buildWhatsAppUrl, generalCtaSchema, type GeneralCta } from "@grausvera/public-content";

export function PublicCta(input: GeneralCta) {
  const cta = generalCtaSchema.parse(input);

  return (
    <div className="public-cta">
      <a href={buildWhatsAppUrl(cta).toString()}>Conversar por WhatsApp</a>
      <a href={`mailto:${cta.email}`}>Escribir por correo</a>
    </div>
  );
}
