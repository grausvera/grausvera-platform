import Link from "next/link";
import { ConsoleSignOut } from "../../components/console-sign-out";
import { getBriefReviewStore, getOperatorStore, requireOperator } from "../../lib/operator-session";

export const dynamic = "force-dynamic";

export default async function OperatorConsolePage() {
  const principal = await requireOperator();
  const store = getOperatorStore();
  const cases = await store.listCases(principal).finally(() => store.close());
  const reviewStore = getBriefReviewStore();
  const revisions = await reviewStore.listQueue(principal).finally(() => reviewStore.close());

  return (
    <main id="contenido" className="page-shell console-shell">
      <header className="console-heading">
        <div>
          <p className="eyebrow">Consola interna</p>
          <h1>Casos</h1>
        </div>
        <div className="console-actions">
          <Link href="/console/seguridad">Seguridad</Link>
          <ConsoleSignOut />
        </div>
      </header>
      <section className="console-panel" aria-labelledby="review-queue-heading">
        <h2 id="review-queue-heading">Revisiones internas</h2>
        {revisions.length === 0 ? (
          <p>No hay revisiones asignadas.</p>
        ) : (
          <ul className="console-case-list">
            {revisions.map((revision) => (
              <li key={revision.id}>
                <Link href={`/console/revisiones/${revision.id}`}>
                  Revisión {revision.revisionNumber}
                </Link>
                <span>{revision.reviewStatus ?? revision.status}</span>
                <small>Caso {revision.caseId}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
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
