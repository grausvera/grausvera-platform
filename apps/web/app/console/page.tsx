import Link from "next/link";
import { ConsoleSignOut } from "../../components/console-sign-out";
import {
  getBriefReviewStore,
  getOperationalStore,
  getOperatorStore,
  requireOperator,
} from "../../lib/operator-session";

export const dynamic = "force-dynamic";

export default async function OperatorConsolePage() {
  const principal = await requireOperator();
  const store = getOperatorStore();
  const cases = await store.listCases(principal).finally(() => store.close());
  const reviewStore = getBriefReviewStore();
  const revisions = await reviewStore.listQueue(principal).finally(() => reviewStore.close());
  const operationalStore = getOperationalStore();
  const operation = await operationalStore
    .dashboard(principal)
    .finally(() => operationalStore.close());
  const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(4)}`;

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
      <section className="console-panel console-operations" aria-labelledby="operation-heading">
        <h2 id="operation-heading">Operación</h2>
        <p>
          Corte{" "}
          <time dateTime={operation.generatedAt.toISOString()}>
            {operation.generatedAt.toLocaleString("es-PE")}
          </time>
        </p>
        <dl className="console-metrics">
          <div>
            <dt>Casos hoy / mes</dt>
            <dd>
              {operation.cases.today} / {operation.cases.month}
            </dd>
          </div>
          <div>
            <dt>Activos / atención humana</dt>
            <dd>
              {operation.cases.active} / {operation.cases.awaitingHuman}
            </dd>
          </div>
          <div>
            <dt>Inbox pendiente</dt>
            <dd>{operation.delivery.pendingInbox}</dd>
          </div>
          <div>
            <dt>Inbox con intervención</dt>
            <dd>{operation.delivery.actionInbox}</dd>
          </div>
          <div>
            <dt>Salidas inciertas / con acción</dt>
            <dd>
              {operation.delivery.uncertainOutbox + operation.delivery.uncertainDeliveries} /{" "}
              {operation.delivery.actionOutbox}
            </dd>
          </div>
          <div>
            <dt>Webhook p95 observado</dt>
            <dd>
              {operation.delivery.webhookP95Ms === null
                ? "Sin muestra"
                : `${operation.delivery.webhookP95Ms} ms`}
            </dd>
          </div>
          <div>
            <dt>Máximo mensajes / adjuntos por caso</dt>
            <dd>
              {operation.capacity.maxMessagesPerCase} / {operation.capacity.maxAttachmentsPerCase}
            </dd>
          </div>
          <div>
            <dt>Briefs este mes</dt>
            <dd>{operation.capacity.briefsThisMonth}</dd>
          </div>
          <div>
            <dt>Modelos consumido / comprometido</dt>
            <dd>
              {usd(operation.cost.modelConsumedMicros)} /{" "}
              {usd(operation.cost.modelReservedMicros + operation.cost.modelUncertainMicros)}
            </dd>
          </div>
        </dl>
        <h3>Alertas e intervenciones</h3>
        {operation.alerts.length === 0 ? (
          <p>No hay alertas activas.</p>
        ) : (
          <ul className="console-case-list">
            {operation.alerts.map((alert) => (
              <li key={`${alert.code}:${alert.evidence}`}>
                <strong>
                  {alert.severity} · {alert.code}
                </strong>
                <span>{alert.action}</span>
                <small>Responsable: {alert.owner}</small>
                <small>Evidencia: {alert.evidence}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
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
