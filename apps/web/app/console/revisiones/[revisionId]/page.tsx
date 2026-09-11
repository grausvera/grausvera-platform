import Link from "next/link";
import { getBriefReviewStore, requireOperator } from "../../../../lib/operator-session";
import {
  approveBriefRevision,
  editBriefRevision,
  rejectBriefRevision,
  submitBriefRevision,
} from "../../actions";

export const dynamic = "force-dynamic";

export default async function BriefRevisionPage({
  params,
}: {
  params: Promise<{ revisionId: string }>;
}) {
  const principal = await requireOperator();
  const { revisionId } = await params;
  const store = getBriefReviewStore();
  const revision = await store.getRevision(principal, revisionId).finally(() => store.close());
  const snapshot = JSON.stringify(revision.snapshot, null, 2);

  return (
    <main id="contenido" className="page-shell console-shell">
      <Link href="/console">← Revisiones</Link>
      <p className="eyebrow">
        Revisión {revision.revisionNumber} · {revision.reviewStatus ?? revision.status}
      </p>
      <h1>Brief interno</h1>
      <p>
        Caso <Link href={`/console/casos/${revision.caseId}`}>{revision.caseId}</Link>
      </p>
      <pre className="console-secret">{snapshot}</pre>
      {revision.status === "DRAFT" && (
        <form action={submitBriefRevision} className="console-form">
          <input type="hidden" name="revisionId" value={revision.id} />
          <button type="submit">Enviar a revisión</button>
        </form>
      )}
      {["DRAFT", "IN_REVIEW", "APPROVED"].includes(revision.status) && (
        <form action={editBriefRevision} className="console-form">
          <input type="hidden" name="revisionId" value={revision.id} />
          <label>
            Snapshot JSON corregido
            <textarea name="snapshot" rows={18} defaultValue={snapshot} required />
          </label>
          <label>
            Motivo de la nueva revisión
            <input name="reason" maxLength={500} required />
          </label>
          <button type="submit">Crear nueva revisión</button>
        </form>
      )}
      {revision.status === "IN_REVIEW" && revision.reviewStatus === "PENDING" && (
        <section className="console-panel">
          <h2>Decisión</h2>
          <form action={approveBriefRevision} className="console-form">
            <input type="hidden" name="revisionId" value={revision.id} />
            <label>
              Comentario opcional
              <textarea name="comments" rows={3} maxLength={2000} />
            </label>
            <button type="submit">Aprobar revisión exacta</button>
            <small>Exige autenticación completa realizada durante los últimos cinco minutos.</small>
          </form>
          <form action={rejectBriefRevision} className="console-form">
            <input type="hidden" name="revisionId" value={revision.id} />
            <label>
              Motivo del rechazo
              <textarea name="comments" rows={3} maxLength={2000} required />
            </label>
            <button type="submit">Rechazar revisión</button>
          </form>
        </section>
      )}
      {revision.status === "APPROVED" && (
        <p>Revisión aprobada. La entrega permanece pendiente de verificación de correo.</p>
      )}
    </main>
  );
}
