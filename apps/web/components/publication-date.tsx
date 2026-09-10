export function PublicationDate({ value }: { value: string | undefined }) {
  if (!value) return null;

  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat("es-PE", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value))}
    </time>
  );
}
