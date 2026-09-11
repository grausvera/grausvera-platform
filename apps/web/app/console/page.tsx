import Link from "next/link";
import { ConsoleSignOut } from "../../components/console-sign-out";
import {
  getBriefReviewStore,
  getOperationalStore,
  getOperatorStore,
  requireOperator,
} from "../../lib/operator-session";

export const dynamic = "force-dynamic";

const labels: Record<string, string> = {
  HUMAN_ACTION_OVERDUE: "Atención humana atrasada",
  PROVIDER_EFFECT_UNCERTAIN: "Entrega pendiente de conciliación",
  MODEL_BUDGET_ALERT: "Presupuesto de modelos en observación",
  MODEL_BUDGET_LIMIT: "Límite de modelos alcanzado",
  HUMAN_ASSISTANCE_REQUESTED: "Atender solicitud humana",
  ENGINEER_REVIEW: "Revisar como especialista",
  RECONCILE_PROVIDER_EFFECT: "Conciliar con el proveedor antes de reenviar",
  CONTINUE_MANUALLY_OR_REVIEW_BUDGET: "Continuar manualmente o revisar presupuesto",
  NEW: "Nuevo",
  AWAITING_CONSENT: "Esperando consentimiento",
  INTERVIEWING: "En entrevista",
  PAUSED: "En pausa",
  NEEDS_INFORMATION: "Necesita información",
  READY_FOR_SYNTHESIS: "Listo para preparar el brief",
  SYNTHESIZING: "Preparando brief",
  AWAITING_EMAIL_VERIFICATION: "Esperando verificación de correo",
  PROSPECT_CONFIRMATION: "Esperando confirmación",
  QUALIFIED: "Calificado",
  NOT_A_FIT: "No aplicable",
  CLOSED: "Cerrado",
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

function readable(value: string | null | undefined) {
  if (!value) return "Sin siguiente acción";
  return labels[value] ?? value.toLowerCase().replaceAll("_", " ");
}

function shortId(id: string) {
  return id.slice(0, 8);
}

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
                  {alert.severity} · {readable(alert.code)}
                </strong>
                <span>{readable(alert.action)}</span>
                <small>Responsable: operador de grausvera</small>
                {alert.evidence.startsWith("case:") ? (
                  <Link href={`/console/casos/${alert.evidence.slice(5).split("@")[0]}`}>
                    Abrir caso {shortId(alert.evidence.slice(5).split("@")[0] ?? "")}
                  </Link>
                ) : (
                  <small>Evidencia operativa disponible</small>
                )}
                <details>
                  <summary>Detalles técnicos</summary>
                  <small>
                    {alert.code} · {alert.action} · {alert.evidence}
                  </small>
                </details>
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
                <span>{readable(revision.reviewStatus ?? revision.status)}</span>
                <small>Caso {shortId(revision.caseId)}</small>
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
              <Link href={`/console/casos/${item.id}`}>Caso {shortId(item.id)}</Link>
              <span>{readable(item.status)}</span>
              <small>{readable(item.nextAction)}</small>
              <details>
                <summary>Identificador técnico</summary>
                <small>{item.id}</small>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
