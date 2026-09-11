import { createHash } from "node:crypto";
import type { BudgetStore, ContextPackageV1, ModelInvocationStore } from "@grausvera/database";
import {
  INTERVIEW_EXTRACTION_PROMPT,
  INTERVIEW_EXTRACTION_SCHEMA,
} from "./prompts/interview-extraction-v1.js";
import { NEXT_QUESTION_PROMPT, NEXT_QUESTION_SCHEMA } from "./prompts/next-question-v1.js";

export interface ModelRequest {
  model: string;
  reasoningEffort: "none" | "low" | "medium";
  instructions: string;
  context: ContextPackageV1;
  schema: object;
  maxOutputTokens: number;
}

export type ModelResult =
  | {
      kind: "completed";
      responseId: string;
      output: unknown;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    }
  | { kind: "failed"; errorCode: string; retryable: boolean; latencyMs: number }
  | { kind: "uncertain"; errorCode: string; latencyMs: number };

export interface ModelPort {
  invoke(request: ModelRequest): Promise<ModelResult>;
}

export class FakeModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly results: ModelResult[]) {}
  async invoke(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    return (
      this.results.shift() ?? {
        kind: "failed",
        errorCode: "fake_result_missing",
        retryable: false,
        latencyMs: 0,
      }
    );
  }
}

type Fetch = typeof fetch;

export class OpenAIModelPort implements ModelPort {
  constructor(
    private readonly options: { apiKey: string; timeoutMs: number },
    private readonly request: Fetch = fetch,
  ) {
    if (!options.apiKey) throw new Error("openai_api_key_required");
  }

  async invoke(request: ModelRequest): Promise<ModelResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          reasoning: { effort: request.reasoningEffort },
          instructions: request.instructions,
          input: JSON.stringify(request.context),
          tools: [],
          store: false,
          max_output_tokens: request.maxOutputTokens,
          text: {
            format: {
              type: "json_schema",
              name: `${request.context.purpose.toLowerCase()}_v1`,
              strict: true,
              schema: request.schema,
            },
          },
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        if (response.status === 429)
          return { kind: "failed", errorCode: "openai_rate_limited", retryable: true, latencyMs };
        if (response.status >= 500)
          return { kind: "uncertain", errorCode: `openai_http_${response.status}`, latencyMs };
        return {
          kind: "failed",
          errorCode: `openai_http_${response.status}`,
          retryable: false,
          latencyMs,
        };
      }
      const body = (await response.json()) as {
        id?: string;
        status?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = body.output
        ?.flatMap((item) => item.content ?? [])
        .find((content) => content.type === "output_text")?.text;
      if (body.status !== "completed" || !body.id || !text)
        return { kind: "uncertain", errorCode: "openai_response_incomplete", latencyMs };
      try {
        return {
          kind: "completed",
          responseId: body.id,
          output: JSON.parse(text),
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
          latencyMs,
        };
      } catch {
        return {
          kind: "completed",
          responseId: body.id,
          output: text,
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
          latencyMs,
        };
      }
    } catch {
      return {
        kind: "uncertain",
        errorCode: controller.signal.aborted ? "openai_timeout" : "openai_network_unknown",
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
const boundedStrings = (value: unknown, maximumItems: number, maximumLength: number) => {
  const values = strings(value);
  return values &&
    values.length <= maximumItems &&
    new Set(values).size === values.length &&
    values.every((item) => item.length > 0 && item.length <= maximumLength)
    ? values
    : undefined;
};
const exactKeys = (value: JsonObject, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function validateInterviewExtraction(
  value: unknown,
  context: ContextPackageV1,
): value is JsonObject {
  const root = object(value);
  const rootKeys = [
    "language",
    "intent",
    "facts",
    "corrections",
    "contradictions",
    "stopRequested",
    "humanRequested",
    "candidateTopics",
    "warnings",
  ];
  if (
    !root ||
    !exactKeys(root, rootKeys) ||
    typeof root.language !== "string" ||
    root.language.length < 2 ||
    root.language.length > 20 ||
    typeof root.intent !== "string" ||
    root.intent.length === 0 ||
    root.intent.length > 200 ||
    typeof root.stopRequested !== "boolean" ||
    typeof root.humanRequested !== "boolean" ||
    !boundedStrings(root.candidateTopics, 10, 80) ||
    !boundedStrings(root.warnings, 10, 500) ||
    !Array.isArray(root.facts) ||
    root.facts.length > 20 ||
    !Array.isArray(root.corrections) ||
    root.corrections.length > 10 ||
    !Array.isArray(root.contradictions) ||
    root.contradictions.length > 10
  )
    return false;
  const messageIds = new Set(context.messages.map((message) => message.id));
  const claimIds = new Set(context.currentClaims.map((claim) => claim.id));
  const validSources = (candidate: JsonObject) => {
    const sources = boundedStrings(candidate.sourceMessageIds, 5, 36);
    return Boolean(sources?.length && sources.every((id) => messageIds.has(id)));
  };
  const factsValid = root.facts.every((item) => {
    const fact = object(item);
    return Boolean(
      fact &&
        exactKeys(fact, [
          "clientRef",
          "category",
          "value",
          "confidence",
          "sensitivity",
          "sourceMessageIds",
        ]) &&
        typeof fact.clientRef === "string" &&
        fact.clientRef.length > 0 &&
        fact.clientRef.length <= 80 &&
        typeof fact.category === "string" &&
        fact.category.length > 0 &&
        fact.category.length <= 80 &&
        typeof fact.value === "string" &&
        fact.value.length > 0 &&
        fact.value.length <= 2_000 &&
        typeof fact.confidence === "number" &&
        fact.confidence >= 0 &&
        fact.confidence <= 1 &&
        ["PUBLIC", "CONTACT", "CONFIDENTIAL", "SENSITIVE"].includes(String(fact.sensitivity)) &&
        validSources(fact),
    );
  });
  const correctionsValid = root.corrections.every((item) => {
    const correction = object(item);
    return Boolean(
      correction &&
        exactKeys(correction, ["targetClaimId", "replacement", "sourceMessageIds"]) &&
        typeof correction.replacement === "string" &&
        correction.replacement.length > 0 &&
        correction.replacement.length <= 2_000 &&
        claimIds.has(String(correction.targetClaimId)) &&
        validSources(correction),
    );
  });
  const contradictionsValid = root.contradictions.every((item) => {
    const contradiction = object(item);
    const referencedClaims = contradiction && boundedStrings(contradiction.claimIds, 10, 36);
    return Boolean(
      contradiction &&
        exactKeys(contradiction, ["claimIds", "explanation", "sourceMessageIds"]) &&
        typeof contradiction.explanation === "string" &&
        contradiction.explanation.length > 0 &&
        contradiction.explanation.length <= 2_000 &&
        referencedClaims?.length &&
        referencedClaims.every((id) => claimIds.has(id)) &&
        validSources(contradiction),
    );
  });
  return factsValid && correctionsValid && contradictionsValid;
}

export type NextQuestionV1 =
  | {
      action: "ASK";
      question: string;
      reasonCode: string;
      targetTopic: string;
      referencedClaimIds: string[];
    }
  | {
      action: "SUMMARIZE";
      summary: string;
      reasonCode: string;
      referencedClaimIds: string[];
    }
  | {
      action: "PAUSE" | "ESCALATE" | "READY";
      reasonCode: string;
      referencedClaimIds: string[];
    };

export function validateNextQuestion(
  value: unknown,
  context: ContextPackageV1,
): value is NextQuestionV1 {
  const root = object(value);
  if (!root || typeof root.action !== "string") return false;
  const references = boundedStrings(root.referencedClaimIds, 20, 36);
  const allowedClaims = new Set(context.currentClaims.map((claim) => claim.id));
  if (
    !references ||
    references.some((id) => !allowedClaims.has(id)) ||
    typeof root.reasonCode !== "string" ||
    root.reasonCode.trim().length === 0 ||
    root.reasonCode.length > 80
  )
    return false;
  if (root.action === "ASK") {
    return Boolean(
      exactKeys(root, ["action", "question", "reasonCode", "targetTopic", "referencedClaimIds"]) &&
        typeof root.question === "string" &&
        root.question.trim().length > 0 &&
        root.question.length <= 500 &&
        (root.question.match(/\?/g) ?? []).length === 1 &&
        typeof root.targetTopic === "string" &&
        context.sufficiency.missing.includes(root.targetTopic),
    );
  }
  if (root.action === "SUMMARIZE")
    return Boolean(
      exactKeys(root, ["action", "summary", "reasonCode", "referencedClaimIds"]) &&
        typeof root.summary === "string" &&
        root.summary.trim().length > 0 &&
        root.summary.length <= 500,
    );
  if (!["PAUSE", "ESCALATE", "READY"].includes(root.action)) return false;
  return (
    exactKeys(root, ["action", "reasonCode", "referencedClaimIds"]) &&
    (root.action !== "READY" || context.sufficiency.sufficient)
  );
}

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export class InterviewExtractionRunner {
  constructor(
    private readonly budgets: BudgetStore,
    private readonly invocations: ModelInvocationStore,
    private readonly models: ModelPort,
    private readonly config: {
      model: string;
      maximumCostMicros: number;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
    },
  ) {}

  async run(input: {
    organizationId: string;
    caseId: string;
    messageIds: string[];
    logicalOperationKey: string;
    attemptKey: string;
    correlationId: string;
  }) {
    const { interviewId, context } = await this.invocations.buildExtractionContext(input);
    const reservation = await this.budgets.reserve({
      organizationId: input.organizationId,
      caseId: input.caseId,
      stage: "INTERVIEW",
      purpose: "INTERVIEW_EXTRACT",
      logicalOperationKey: input.logicalOperationKey,
      attemptKey: input.attemptKey,
      maximumCostMicros: this.config.maximumCostMicros,
      correlationId: input.correlationId,
    });
    const invocation = await this.invocations.create({
      organizationId: input.organizationId,
      caseId: input.caseId,
      interviewId,
      reservationId: reservation.reservationId,
      provider: "OPENAI",
      model: this.config.model,
      reasoningEffort: "low",
      promptId: INTERVIEW_EXTRACTION_PROMPT.id,
      promptVersion: INTERVIEW_EXTRACTION_PROMPT.version,
      promptHash: sha256(INTERVIEW_EXTRACTION_PROMPT.instructions),
      schemaId: "InterviewExtractionV1",
      schemaVersion: 1,
      schemaHash: sha256(INTERVIEW_EXTRACTION_SCHEMA),
      context,
      initialStatus: reservation.allowed ? "RESERVED" : "BUDGET_REJECTED",
    });
    if (!invocation.created) return { kind: "replayed" as const, invocationId: invocation.id };
    const invocationId = invocation.id;
    if (!reservation.allowed) return { kind: "budget_rejected" as const, invocationId };
    const result = await this.models.invoke({
      model: this.config.model,
      reasoningEffort: "low",
      instructions: INTERVIEW_EXTRACTION_PROMPT.instructions,
      context,
      schema: INTERVIEW_EXTRACTION_SCHEMA,
      maxOutputTokens: 800,
    });
    if (result.kind === "uncertain") {
      await this.budgets.reconcile({
        organizationId: input.organizationId,
        reservationId: reservation.reservationId,
        outcome: "UNCERTAIN",
        correlationId: input.correlationId,
      });
      await this.invocations.finish({
        organizationId: input.organizationId,
        invocationId,
        status: "UNCERTAIN",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });
      return { kind: "uncertain" as const, invocationId };
    }
    if (result.kind === "failed") {
      await this.budgets.reconcile({
        organizationId: input.organizationId,
        reservationId: reservation.reservationId,
        outcome: "RELEASED",
        correlationId: input.correlationId,
      });
      await this.invocations.finish({
        organizationId: input.organizationId,
        invocationId,
        status: "FAILED",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });
      return { kind: "failed" as const, invocationId, retryable: result.retryable };
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
    const valid = validateInterviewExtraction(result.output, context);
    await this.invocations.finish({
      organizationId: input.organizationId,
      invocationId,
      status: valid ? "SUCCEEDED" : "INVALID",
      providerResponseId: result.responseId,
      output: result.output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros,
      latencyMs: result.latencyMs,
      errorCode: valid ? undefined : "model_output_invalid",
    });
    return { kind: valid ? ("candidates" as const) : ("invalid" as const), invocationId };
  }
}

export class NextQuestionRunner {
  constructor(
    private readonly budgets: BudgetStore,
    private readonly invocations: ModelInvocationStore,
    private readonly models: ModelPort,
    private readonly config: {
      model: string;
      maximumCostMicros: number;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
    },
  ) {}

  async run(input: {
    organizationId: string;
    caseId: string;
    messageIds: string[];
    logicalOperationKey: string;
    attemptKey: string;
    correlationId: string;
  }) {
    const { interviewId, context } = await this.invocations.buildExtractionContext({
      ...input,
      purpose: "NEXT_QUESTION",
    });
    const reservation = await this.budgets.reserve({
      organizationId: input.organizationId,
      caseId: input.caseId,
      stage: "INTERVIEW",
      purpose: "NEXT_QUESTION",
      logicalOperationKey: input.logicalOperationKey,
      attemptKey: input.attemptKey,
      maximumCostMicros: this.config.maximumCostMicros,
      correlationId: input.correlationId,
    });
    const invocation = await this.invocations.create({
      organizationId: input.organizationId,
      caseId: input.caseId,
      interviewId,
      reservationId: reservation.reservationId,
      purpose: "NEXT_QUESTION",
      provider: "OPENAI",
      model: this.config.model,
      reasoningEffort: "low",
      promptId: NEXT_QUESTION_PROMPT.id,
      promptVersion: NEXT_QUESTION_PROMPT.version,
      promptHash: sha256(NEXT_QUESTION_PROMPT.instructions),
      schemaId: "NextQuestionV1",
      schemaVersion: 1,
      schemaHash: sha256(NEXT_QUESTION_SCHEMA),
      context,
      initialStatus: reservation.allowed ? "RESERVED" : "BUDGET_REJECTED",
    });
    if (!invocation.created) return { kind: "replayed" as const, invocationId: invocation.id };
    if (!reservation.allowed)
      return { kind: "budget_rejected" as const, invocationId: invocation.id };
    const result = await this.models.invoke({
      model: this.config.model,
      reasoningEffort: "low",
      instructions: NEXT_QUESTION_PROMPT.instructions,
      context,
      schema: NEXT_QUESTION_SCHEMA,
      maxOutputTokens: 800,
    });
    if (result.kind === "uncertain") {
      await this.budgets.reconcile({
        organizationId: input.organizationId,
        reservationId: reservation.reservationId,
        outcome: "UNCERTAIN",
        correlationId: input.correlationId,
      });
      await this.invocations.finish({
        organizationId: input.organizationId,
        invocationId: invocation.id,
        status: "UNCERTAIN",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });
      return { kind: "uncertain" as const, invocationId: invocation.id };
    }
    if (result.kind === "failed") {
      await this.budgets.reconcile({
        organizationId: input.organizationId,
        reservationId: reservation.reservationId,
        outcome: "RELEASED",
        correlationId: input.correlationId,
      });
      await this.invocations.finish({
        organizationId: input.organizationId,
        invocationId: invocation.id,
        status: "FAILED",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });
      return { kind: "failed" as const, invocationId: invocation.id, retryable: result.retryable };
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
    const valid = validateNextQuestion(result.output, context);
    const finished = await this.invocations.finish({
      organizationId: input.organizationId,
      invocationId: invocation.id,
      status: valid ? "SUCCEEDED" : "INVALID",
      providerResponseId: result.responseId,
      output: result.output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros,
      latencyMs: result.latencyMs,
      errorCode: valid ? undefined : "model_output_invalid",
      nextActionProposal: valid ? (result.output as NextQuestionV1) : undefined,
    });
    if (!valid) return { kind: "invalid" as const, invocationId: invocation.id };
    const proposalOutput = result.output as NextQuestionV1;
    if (!finished.proposalId) throw new Error("next_action_proposal_not_persisted");
    return {
      kind: "proposal" as const,
      invocationId: invocation.id,
      proposalId: finished.proposalId,
      action: proposalOutput.action,
    };
  }
}
