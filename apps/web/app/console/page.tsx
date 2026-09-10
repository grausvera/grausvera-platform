import Link from "next/link";
import { ConsoleSignOut } from "../../components/console-sign-out";
import { getOperatorStore, requireOperator } from "../../lib/operator-session";

export const dynamic = "force-dynamic";

export default async function OperatorConsolePage() {
  const principal = await requireOperator();
  const store = getOperatorStore();
  const cases = await store.listCases(principal).finally(() => store.close());

  return (
    <main id="contenido" className="page-shell console-shell">
      <header className="console-heading">
        <div>
          <p className="eyebrow">Consola interna</p>
          <h1>Casos</h1>
        </div>
        <ConsoleSignOut />
      </header>
      {cases.length === 0 ? (
        <p>No hay casos disponibles.</p>
      ) : (
        <ul className="console-case-list">
          {cases.map((item) => (
            <li key={item.id}>
              <Link href={`/console/casos/${item.id}`}>{item.id}</Link>
              <span>{item.status}</span>
              <small>{item.nextAction ?? "Sin siguiente acción"}</small>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
