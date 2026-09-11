import Link from "next/link";
import { requireOperator } from "../../../lib/operator-session";
import { OperatorSecuritySettings } from "./security-settings";

export const dynamic = "force-dynamic";

export default async function OperatorSecurityPage() {
  await requireOperator();

  return (
    <main id="contenido" className="page-shell console-shell">
      <Link href="/console">← Consola</Link>
      <p className="eyebrow">Consola interna</p>
      <h1>Seguridad</h1>
      <OperatorSecuritySettings />
    </main>
  );
}
