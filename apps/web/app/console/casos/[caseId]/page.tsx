import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getOperatorStore, requireOperator } from "../../../../lib/operator-session";
import { pauseCase, respondToCase, takeCase } from "../../actions";

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
      </div>
      <ol className="console-messages">
        {item.messages.map((message) => (
          <li key={message.id} data-direction={message.direction}>
            <small>{message.direction === "INBOUND" ? "Contacto" : "grausvera"}</small>
            <p>{message.text ?? `[${message.type}]`}</p>
          </li>
        ))}
      </ol>
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
