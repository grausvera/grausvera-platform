"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getKnowledgeStore, getOperatorStore, requireOperator } from "../../lib/operator-session";

function required(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value) throw new Error(`operator_${field}_required`);
  return value;
}

export async function takeCase(form: FormData) {
  const principal = await requireOperator();
  const caseId = required(form, "caseId");
  const store = getOperatorStore();
  try {
    await store.takeCase(principal, caseId, randomUUID());
  } finally {
    await store.close();
  }
  revalidatePath(`/console/casos/${caseId}`);
  revalidatePath("/console");
}

export async function pauseCase(form: FormData) {
  const principal = await requireOperator();
  const caseId = required(form, "caseId");
  const store = getOperatorStore();
  try {
    await store.pauseCase(principal, caseId, randomUUID());
  } finally {
    await store.close();
  }
  revalidatePath(`/console/casos/${caseId}`);
  revalidatePath("/console");
}

export async function respondToCase(form: FormData) {
  const principal = await requireOperator();
  const caseId = required(form, "caseId");
  const store = getOperatorStore();
  try {
    await store.respond(principal, {
      caseId,
      text: required(form, "text"),
      idempotencyKey: required(form, "idempotencyKey"),
      correlationId: randomUUID(),
    });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/casos/${caseId}`);
}

export async function correctClaim(form: FormData) {
  const principal = await requireOperator();
  const caseId = required(form, "caseId");
  const [sourceKind, sourceId, ...unexpected] = required(form, "sourceReference").split(":");
  if (
    !sourceKind ||
    !sourceId ||
    unexpected.length > 0 ||
    !["MESSAGE", "ATTACHMENT", "EXTERNAL"].includes(sourceKind)
  )
    throw new Error("operator_source_kind_invalid");
  const confidenceBasisPoints = Number(required(form, "confidenceBasisPoints"));
  const store = getKnowledgeStore();
  try {
    await store.correctClaim(principal, {
      caseId,
      targetClaimId: required(form, "claimId"),
      replacement: required(form, "replacement"),
      confidenceBasisPoints,
      source: {
        kind: sourceKind as "MESSAGE" | "ATTACHMENT" | "EXTERNAL",
        id: sourceId,
        relation: "SUPPORTS",
      },
      correlationId: randomUUID(),
    });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/casos/${caseId}`);
}
