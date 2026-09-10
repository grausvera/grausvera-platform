import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-shell" id="contenido" tabIndex={-1}>
      <article className="public-page">
        <header className="page-heading">
          <p className="eyebrow">404</p>
          <h1>No encontramos esta página.</h1>
          <p className="lede">
            Es posible que el contenido todavía no esté publicado o que la dirección haya cambiado.
          </p>
        </header>
        <Link href="/">Volver al inicio</Link>
      </article>
    </main>
  );
}
