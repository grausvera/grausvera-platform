import { randomUUID } from "node:crypto";
import Link from "next/link";
import {
  getKnowledgeStore,
  getOperatorStore,
  requireOperator,
} from "../../../../lib/operator-session";
import {
  correctClaim,
  pauseCase,
  requestBriefSynthesis,
  respondToCase,
  takeCase,
} from "../../actions";

export const dynamic = "force-dynamic";

export default async function OperatorCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const principal = await requireOperator();
  const { caseId } = await params;
  const store = getOperatorStore();
  const item = await store.getCase(principal, caseId).finally(() => store.close());
  const knowledge = getKnowledgeStore();
  const claims = await knowledge.listCaseClaims(principal, caseId).finally(() => knowledge.close());

  return (
    <main id="contenido" className="page-shell console-shell">
      <Link href="/console">← Casos</Link>
      <p className="eyebrow">Caso {item.status}</p>
      <h1>Conversación</h1>
      <div className="console-actions">
        {!item.assigned && (
          <form action={takeCase}>
            <input type="hidden" name="caseId" value={caseId} />
            <button type="submit">Tomar caso</button>
          </form>
        )}
        <form action={pauseCase}>
          <input type="hidden" name="caseId" value={caseId} />
          <button type="submit">Pausar</button>
        </form>
        {item.assigned && item.status === "READY_FOR_SYNTHESIS" && (
          <form action={requestBriefSynthesis}>
            <input type="hidden" name="caseId" value={caseId} />
            <button type="submit">Solicitar síntesis interna</button>
          </form>
        )}
      </div>
      <ol className="console-messages">
        {item.messages.map((message) => (
          <li key={message.id} id={`message-${message.id}`} data-direction={message.direction}>
            <small>{message.direction === "INBOUND" ? "Contacto" : "grausvera"}</small>
            <p>{message.text ?? `[${message.type}]`}</p>
          </li>
        ))}
      </ol>
      <section className="console-knowledge" aria-labelledby="knowledge-heading">
        <h2 id="knowledge-heading">Conocimiento y procedencia</h2>
        {claims.length === 0 ? (
          <p>Todavía no hay afirmaciones registradas para este caso.</p>
        ) : (
          <ol className="console-claims">
            {claims.map((trace) => (
              <li key={trace.claim.id} id={`claim-${trace.claim.id}`}>
                <small>
                  {trace.claim.kind} · {trace.claim.validity}
                </small>
                <p>{trace.claim.content}</p>
                <h3>Fuentes</h3>
                <ul>
                  {trace.sources.map((source) => (
                    <li key={source.id}>
                      {source.href ? (
                        <a
                          href={source.href}
                          {...(source.kind === "EXTERNAL"
                            ? { target: "_blank", rel: "noreferrer" }
                            : {})}
                        >
                          {source.label ?? source.kind}
                        </a>
                      ) : (
                        <span>{source.label ?? source.kind}</span>
                      )}{" "}
                      <small>({source.relation})</small>
                    </li>
                  ))}
                </ul>
                {trace.relations.length > 0 && (
                  <>
                    <h3>Relaciones</h3>
                    <ul>
                      {trace.relations.map((relation) => (
                        <li key={`${relation.direction}-${relation.relation}-${relation.claimId}`}>
                          <a href={`#claim-${relation.claimId}`}>{relation.relation}</a>:{" "}
                          {relation.content}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {item.assigned &&
                  trace.claim.validity === "CURRENT" &&
                  trace.sources.length > 0 && (
                    <form action={correctClaim} className="console-form console-correction-form">
                      <input type="hidden" name="caseId" value={caseId} />
                      <input type="hidden" name="claimId" value={trace.claim.id} />
                      <label>
                        Fuente de la corrección
                        <select name="sourceReference" required defaultValue="">
                          <option value="" disabled>
                            Selecciona una fuente
                          </option>
                          {trace.sources.map((source) => (
                            <option key={source.id} value={`${source.kind}:${source.referenceId}`}>
                              {source.label ?? source.kind}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Corrección
                        <textarea name="replacement" rows={3} maxLength={2000} required />
                      </label>
                      <label>
                        Confianza
                        <input
                          name="confidenceBasisPoints"
                          type="number"
                          min="0"
                          max="10000"
                          defaultValue="10000"
                          required
                        />
                      </label>
                      <button type="submit">Registrar corrección</button>
                    </form>
                  )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {item.assigned && (
        <form action={respondToCase} className="console-form">
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>
            Respuesta
            <textarea name="text" rows={5} maxLength={2000} required />
          </label>
          <button type="submit">Enviar respuesta</button>
        </form>
      )}
    </main>
  );
}
