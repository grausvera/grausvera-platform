import Link from "next/link";
import type { PublicRoute } from "@grausvera/public-content";

interface NavigationItem {
  href: PublicRoute;
  label: string;
}

export const AVAILABLE_NAVIGATION = [
  { href: "/", label: "Inicio" },
  { href: "/servicios", label: "Servicios" },
  { href: "/acerca", label: "Acerca" },
] as const satisfies readonly NavigationItem[];

export function PublicNavigation() {
  return (
    <nav aria-label="Navegación principal" className="site-nav">
      <ul>
        {AVAILABLE_NAVIGATION.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
