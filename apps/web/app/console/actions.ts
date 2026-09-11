"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  getBriefSynthesisStore,
  getBriefReviewStore,
  getKnowledgeStore,
  getOperatorStore,
  requireOperator,
  requireRecentOperator,
} from "../../lib/operator-session";

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

export async function requestBriefSynthesis(form: FormData) {
  const principal = await requireOperator();
  const caseId = required(form, "caseId");
  const store = getBriefSynthesisStore();
  try {
    await store.request(principal, { caseId, correlationId: randomUUID() });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/casos/${caseId}`);
}

export async function editBriefRevision(form: FormData) {
  const principal = await requireOperator();
  const revisionId = required(form, "revisionId");
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(required(form, "snapshot"));
  } catch {
    throw new Error("brief_snapshot_invalid");
  }
  const store = getBriefReviewStore();
  try {
    const edited = await store.edit(principal, {
      revisionId,
      snapshot,
      reason: required(form, "reason"),
      correlationId: randomUUID(),
    });
    revalidatePath(`/console/revisiones/${revisionId}`);
    revalidatePath(`/console/revisiones/${edited.revisionId}`);
    revalidatePath("/console");
  } finally {
    await store.close();
  }
}

export async function submitBriefRevision(form: FormData) {
  const principal = await requireOperator();
  const revisionId = required(form, "revisionId");
  const store = getBriefReviewStore();
  try {
    await store.submit(principal, { revisionId, correlationId: randomUUID() });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/revisiones/${revisionId}`);
  revalidatePath("/console");
}

export async function rejectBriefRevision(form: FormData) {
  const principal = await requireOperator();
  const revisionId = required(form, "revisionId");
  const store = getBriefReviewStore();
  try {
    await store.reject(principal, {
      revisionId,
      comments: required(form, "comments"),
      correlationId: randomUUID(),
    });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/revisiones/${revisionId}`);
  revalidatePath("/console");
}

export async function approveBriefRevision(form: FormData) {
  const principal = await requireRecentOperator();
  const revisionId = required(form, "revisionId");
  const comments = form.get("comments");
  const store = getBriefReviewStore();
  try {
    await store.approve(principal, {
      revisionId,
      comments: typeof comments === "string" ? comments : undefined,
      correlationId: randomUUID(),
    });
  } finally {
    await store.close();
  }
  revalidatePath(`/console/revisiones/${revisionId}`);
  revalidatePath("/console");
}
