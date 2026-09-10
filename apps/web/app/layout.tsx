import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PublicNavigation } from "../components/public-navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: "grausvera",
  description: "Experiencia pública de grausvera.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#contenido">
          Saltar al contenido
        </a>
        <header className="site-header">
          <Link className="brand" href="/" aria-label="grausvera, inicio">
            grausvera
          </Link>
          <PublicNavigation />
        </header>
        {children}
        <footer className="site-footer">
          <p>grausvera</p>
        </footer>
      </body>
    </html>
  );
}
