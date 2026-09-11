import { createHash } from "node:crypto";
import type {
  BriefSynthesisContextV1,
  BriefSynthesisStore,
  BudgetStore,
} from "@grausvera/database";
import type { ModelPort, ModelResult } from "./model.js";
import { BRIEF_SYNTHESIS_PROMPT, BRIEF_SYNTHESIS_SCHEMA } from "./prompts/brief-synthesis-v1.js";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

const ROOT_KEYS = [
  "title",
  "problem",
  "peopleAndUsers",
  "objectives",
  "currentSituation",
  "scopeIncluded",
  "scopeExcluded",
  "constraints",
  "assumptions",
  "openQuestions",
  "risks",
  "materialClaims",
  "warnings",
] as const;
const CLAIM_KEYS = ["content", "kind", "sourceIds", "confidence"] as const;
const CLAIM_KINDS = new Set(["FACT", "REQUIREMENT", "ASSUMPTION", "INFERENCE", "RISK"]);
const COMMERCIAL_LANGUAGE =
  /(?:\b(?:precio|precios|cotizaci[oó]n|propuesta|contrato|pago|pagos|plazo|fecha de entrega|presupuesto|coste|costo|deadline|price|pricing|quote|proposal|contract|payment)\b|\b(?:USD|PEN)\b|S\/\s*\d|\$\s*\d|\b(?:promet\w*|garantiz\w*|entregaremos|we will deliver)\b)/iu;

export interface BriefSynthesisV1 {
  title: string;
  problem: string;
  peopleAndUsers: string[];
  objectives: string[];
  currentSituation: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  constraints: string[];
  assumptions: string[];
  openQuestions: string[];
  risks: string[];
  materialClaims: Array<{
    content: string;
    kind: "FACT" | "REQUIREMENT" | "ASSUMPTION" | "INFERENCE" | "RISK";
    sourceIds: string[];
    confidence: number;
  }>;
  warnings: string[];
}

const isExactObject = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isString = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const isStringList = (value: unknown) =>
  Array.isArray(value) && value.length <= 20 && value.every((item) => isString(item, 4000));

export function validateBriefSynthesis(
  value: unknown,
  context: BriefSynthesisContextV1,
): value is BriefSynthesisV1 {
  if (!isExactObject(value, ROOT_KEYS)) return false;
  const output = value as Record<string, unknown>;
  if (!isString(output.title, 200) || !isString(output.problem, 4000)) return false;
  if (!isString(output.currentSituation, 4000)) return false;
  const listKeys = ROOT_KEYS.filter(
    (key) => !["title", "problem", "currentSituation", "materialClaims"].includes(key),
  );
  if (!listKeys.every((key) => isStringList(output[key]))) return false;
  if (!Array.isArray(output.materialClaims) || output.materialClaims.length > 50) return false;
  const authorizedSources = new Set(context.claims.flatMap((claim) => claim.sourceIds));
  for (const item of output.materialClaims) {
    if (!isExactObject(item, CLAIM_KEYS)) return false;
    const claim = item as Record<string, unknown>;
    if (!isString(claim.content, 2000) || !CLAIM_KINDS.has(String(claim.kind))) return false;
    if (!Array.isArray(claim.sourceIds) || claim.sourceIds.length > 20) return false;
    if (!claim.sourceIds.every((source) => typeof source === "string")) return false;
    if (new Set(claim.sourceIds).size !== claim.sourceIds.length) return false;
    if (!claim.sourceIds.every((source) => authorizedSources.has(source))) return false;
    if (claim.kind !== "ASSUMPTION" && claim.sourceIds.length === 0) return false;
    if (typeof claim.confidence !== "number" || claim.confidence < 0 || claim.confidence > 1)
      return false;
  }
  const narrative = ROOT_KEYS.flatMap((key) => {
    const field = output[key];
    if (typeof field === "string") return [field];
    if (key === "materialClaims")
      return (field as BriefSynthesisV1["materialClaims"]).map((claim) => claim.content);
    return field as string[];
  });
  return !narrative.some((text) => COMMERCIAL_LANGUAGE.test(text));
}

export class BriefSynthesisRunner {
  constructor(
    private readonly budgets: BudgetStore,
    private readonly store: BriefSynthesisStore,
    private readonly models: ModelPort,
    private readonly config: {
      model: string;
      maximumCostMicros: number;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
      timeoutMs: number;
    },
  ) {}

  async run(input: {
    organizationId: string;
    caseId: string;
    attemptKey: string;
    correlationId: string;
  }) {
    const claim = await this.store.claim(input);
    if (claim.kind !== "claimed") return claim;
    const logicalOperationKey = `brief-synthesis:${input.caseId}:${claim.context.knowledgeVersion}`;
    const reservation = await this.budgets.reserve({
      organizationId: input.organizationId,
      caseId: input.caseId,
      stage: "SYNTHESIS",
      purpose: "BRIEF_SYNTHESIS",
      logicalOperationKey,
      attemptKey: input.attemptKey,
      maximumCostMicros: this.config.maximumCostMicros,
      correlationId: input.correlationId,
    });
    if (!reservation.allowed) {
      await this.store.finish({
        context: claim.context,
        invocationId: "",
        status: "BUDGET_REJECTED",
        errorCode: "budget_rejected",
        latencyMs: 0,
      });
      return { kind: "budget_rejected" as const, requestId: claim.requestId };
    }
    const invocation = {
      provider: "OPENAI",
      model: this.config.model,
      reasoningEffort: "medium",
      promptId: BRIEF_SYNTHESIS_PROMPT.id,
      promptVersion: BRIEF_SYNTHESIS_PROMPT.version,
      promptHash: hash(BRIEF_SYNTHESIS_PROMPT.instructions),
      schemaId: "BriefSynthesisV1",
      schemaVersion: 1,
      schemaHash: hash(BRIEF_SYNTHESIS_SCHEMA),
    };
    const invocationId = await this.store.start({
      context: claim.context,
      reservationId: reservation.reservationId,
      invocation,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ModelResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            kind: "uncertain",
            errorCode: "brief_synthesis_timeout",
            latencyMs: this.config.timeoutMs,
          }),
        this.config.timeoutMs,
      );
    });
    const result = await Promise.race([
      this.models.invoke({
        model: this.config.model,
        reasoningEffort: "medium",
        instructions: BRIEF_SYNTHESIS_PROMPT.instructions,
        context: claim.context,
        schema: BRIEF_SYNTHESIS_SCHEMA,
        maxOutputTokens: 2400,
      }),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (result.kind !== "completed") {
      const uncertain = result.kind === "uncertain";
      await this.budgets.reconcile({
        organizationId: input.organizationId,
        reservationId: reservation.reservationId,
        outcome: uncertain ? "UNCERTAIN" : "RELEASED",
        correlationId: input.correlationId,
      });
      await this.store.finish({
        context: claim.context,
        invocationId,
        status: uncertain ? "UNCERTAIN" : "FAILED",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });
      return { kind: result.kind, requestId: claim.requestId, invocationId };
    }
    const costMicros = Math.ceil(
      result.inputTokens * this.config.inputUsdPerMillion +
        result.outputTokens * this.config.outputUsdPerMillion,
    );
    await this.budgets.reconcile({
      organizationId: input.organizationId,
      reservationId: reservation.reservationId,
      outcome: "CONSUMED",
      actualCostMicros: costMicros,
      correlationId: input.correlationId,
    });
    const valid = validateBriefSynthesis(result.output, claim.context);
    if (!valid) {
      await this.store.finish({
        context: claim.context,
        invocationId,
        status: "INVALID",
        output: result.output,
        errorCode: "brief_synthesis_output_invalid",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros,
        latencyMs: result.latencyMs,
      });
      return {
        kind: "invalid" as const,
        requestId: claim.requestId,
        invocationId,
      };
    }
    const revisionId = await this.store.complete({
      context: claim.context,
      invocationId,
      output: result.output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros,
      latencyMs: result.latencyMs,
      correlationId: input.correlationId,
    });
    return {
      kind: "candidate" as const,
      requestId: claim.requestId,
      invocationId,
      revisionId,
      output: result.output,
    };
  }
}
