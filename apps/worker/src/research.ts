import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type {
  BoundedResearchContextV1,
  BoundedResearchV1,
  BudgetStore,
  KnowledgeOperatorPrincipal,
  ResearchSourceV1,
  ResearchStore,
} from "@grausvera/database";
import type { ModelPort } from "./model.js";
import { BOUNDED_RESEARCH_PROMPT, BOUNDED_RESEARCH_SCHEMA } from "./prompts/bounded-research-v1.js";

export interface ResearchPort {
  search(question: string, limit: number): Promise<string[]>;
  read(url: string): Promise<Omit<ResearchSourceV1, "sourceRef" | "relatedClaimIds" | "relation">>;
}

type Lookup = (hostname: string) => Promise<Array<{ address: string }>>;
export type PinnedResearchFetch = (
  url: URL,
  init: RequestInit,
  approvedAddresses: readonly string[],
) => Promise<Response>;

function publicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("::ffff:127.") ||
      value.startsWith("::ffff:10.") ||
      value.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("research_egress_url_rejected");
  return url;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  if (timeoutMs <= 0) throw new Error(errorCode);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SafeWebResearchPort implements ResearchPort {
  constructor(
    private readonly searchProvider: (question: string, limit: number) => Promise<string[]>,
    private readonly request: PinnedResearchFetch,
    private readonly resolve: Lookup = async (hostname) =>
      dnsLookup(hostname, { all: true, verbatim: true }),
    private readonly timeoutMs = 10_000,
    private readonly maximumBytes = 1_048_576,
  ) {}

  async search(question: string, limit: number): Promise<string[]> {
    if (limit < 1 || limit > 5) throw new Error("research_search_limit_invalid");
    const candidates = await within(
      this.searchProvider(question, limit),
      this.timeoutMs,
      "research_search_timeout",
    );
    return [...new Set(candidates)].slice(0, limit).map((candidate) => safeUrl(candidate).href);
  }

  async read(value: string) {
    let url = safeUrl(value);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const addresses = await this.resolve(url.hostname);
      if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address)))
        throw new Error("research_egress_address_rejected");
      const approvedAddresses = addresses.map(({ address }) => address);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.request(
          url,
          { redirect: "manual", signal: controller.signal },
          approvedAddresses,
        );
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === 3) throw new Error("research_redirect_rejected");
          url = safeUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) throw new Error("research_read_failed");
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (
          !contentType ||
          !["text/html", "text/plain", "application/xhtml+xml"].includes(contentType)
        )
          throw new Error("research_content_type_rejected");
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > this.maximumBytes)
          throw new Error("research_content_too_large");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.maximumBytes) throw new Error("research_content_too_large");
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? url.hostname;
        const excerpt = raw
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200);
        if (!excerpt) throw new Error("research_excerpt_missing");
        return {
          canonicalUrl: url.href,
          title,
          publisher: url.hostname,
          publishedAt: null,
          consultedAt: new Date().toISOString(),
          excerpt,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("research_redirect_rejected");
  }
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function validateBoundedResearch(
  output: unknown,
  context: BoundedResearchContextV1,
): output is BoundedResearchV1 {
  if (!output || typeof output !== "object") return false;
  const value = output as BoundedResearchV1;
  if (
    !exactKeys(value, [
      "researchRequestId",
      "question",
      "sources",
      "findings",
      "unresolvedQuestions",
      "warnings",
    ]) ||
    value.researchRequestId !== context.researchRequestId ||
    value.question !== context.question ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.unresolvedQuestions) ||
    !Array.isArray(value.warnings) ||
    value.sources.length > context.limits.maxReads
  )
    return false;
  const available = new Map(context.sources.map((source) => [source.sourceRef, source]));
  const claimIds = new Set(context.currentClaims.map((claim) => claim.id));
  const seen = new Set<string>();
  for (const source of value.sources) {
    const inspected = available.get(source.sourceRef);
    if (
      !source ||
      typeof source !== "object" ||
      !exactKeys(source, [
        "sourceRef",
        "canonicalUrl",
        "title",
        "publisher",
        "publishedAt",
        "consultedAt",
        "excerpt",
        "contentHash",
        "relatedClaimIds",
        "relation",
      ]) ||
      !inspected ||
      seen.has(source.sourceRef) ||
      source.canonicalUrl !== inspected.canonicalUrl ||
      source.title !== inspected.title ||
      source.publisher !== inspected.publisher ||
      source.publishedAt !== inspected.publishedAt ||
      source.consultedAt !== inspected.consultedAt ||
      source.excerpt !== inspected.excerpt ||
      source.contentHash !== inspected.contentHash ||
      !Array.isArray(source.relatedClaimIds) ||
      new Set(source.relatedClaimIds).size !== source.relatedClaimIds.length ||
      source.relatedClaimIds.some((id) => !claimIds.has(id)) ||
      !["SUPPORTS", "CONTRADICTS", "CONTEXT"].includes(source.relation)
    )
      return false;
    seen.add(source.sourceRef);
  }
  return (
    value.unresolvedQuestions.every(
      (question) => typeof question === "string" && question.trim(),
    ) &&
    value.warnings.every((warning) => typeof warning === "string" && warning.trim()) &&
    value.findings.every(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        exactKeys(finding, ["content", "kind", "sourceRefs", "uncertainty"]) &&
        finding.content?.trim() &&
        finding.uncertainty?.trim() &&
        ["INFERENCE", "UNRESOLVED"].includes(finding.kind) &&
        Array.isArray(finding.sourceRefs) &&
        new Set(finding.sourceRefs).size === finding.sourceRefs.length &&
        finding.sourceRefs.every((ref) => seen.has(ref)) &&
        (finding.kind === "UNRESOLVED" || finding.sourceRefs.length > 0),
    )
  );
}

export class BoundedResearchRunner {
  constructor(
    private readonly budgets: BudgetStore,
    private readonly store: ResearchStore,
    private readonly research: ResearchPort,
    private readonly models: ModelPort,
    private readonly config: {
      model: string;
      maximumCostMicros: number;
      toolCostMicros: number;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
    },
  ) {}

  async run(
    principal: KnowledgeOperatorPrincipal,
    input: {
      caseId: string;
      question: string;
      logicalOperationKey: string;
      attemptKey: string;
      correlationId: string;
    },
  ) {
    const startedAt = Date.now();
    const authorized = await this.store.authorize(principal, input);
    const deadline = startedAt + authorized.context.limits.maxDurationSeconds * 1000;
    const remaining = () => deadline - Date.now();
    const reservation = await this.budgets.reserve({
      organizationId: principal.organizationId,
      caseId: input.caseId,
      stage: "RESEARCH",
      purpose: "BOUNDED_RESEARCH",
      logicalOperationKey: input.logicalOperationKey,
      attemptKey: input.attemptKey,
      maximumCostMicros: this.config.maximumCostMicros,
      correlationId: input.correlationId,
    });
    if (!reservation.allowed) {
      await this.store.rejectBudget({
        organizationId: principal.organizationId,
        researchRequestId: authorized.researchRequestId,
      });
      return { kind: "budget_rejected" as const, researchRequestId: authorized.researchRequestId };
    }
    const urls = await within(
      this.research.search(input.question, authorized.context.limits.maxReads),
      remaining(),
      "research_duration_exceeded",
    ).catch(() => []);
    const inspected: ResearchSourceV1[] = [];
    for (const url of urls.slice(0, authorized.context.limits.maxReads)) {
      try {
        inspected.push({
          ...(await within(this.research.read(url), remaining(), "research_duration_exceeded")),
          sourceRef: `source-${inspected.length + 1}`,
          relatedClaimIds: [],
          relation: "CONTEXT",
        });
      } catch {
        // An inaccessible or rejected source is omitted and cannot become provenance.
      }
    }
    const context: BoundedResearchContextV1 = { ...authorized.context, sources: inspected };
    const invocation = {
      provider: "OPENAI",
      model: this.config.model,
      reasoningEffort: "medium",
      promptId: BOUNDED_RESEARCH_PROMPT.id,
      promptVersion: BOUNDED_RESEARCH_PROMPT.version,
      promptHash: hash(BOUNDED_RESEARCH_PROMPT.instructions),
      schemaId: "BoundedResearchV1",
      schemaVersion: 1,
      schemaHash: hash(BOUNDED_RESEARCH_SCHEMA),
    };
    const invocationId = await this.store.start({
      context,
      reservationId: reservation.reservationId,
      invocation,
    });
    const result = await within(
      this.models.invoke({
        model: this.config.model,
        reasoningEffort: "medium",
        instructions: BOUNDED_RESEARCH_PROMPT.instructions,
        context,
        schema: BOUNDED_RESEARCH_SCHEMA,
        maxOutputTokens: 1200,
      }),
      remaining(),
      "research_duration_exceeded",
    ).catch(
      (): Awaited<ReturnType<ModelPort["invoke"]>> => ({
        kind: "uncertain",
        errorCode: "research_duration_exceeded",
        latencyMs: Date.now() - startedAt,
      }),
    );
    if (result.kind !== "completed") {
      const uncertain = result.kind === "uncertain";
      await this.budgets.reconcile({
        organizationId: principal.organizationId,
        reservationId: reservation.reservationId,
        outcome: uncertain ? "UNCERTAIN" : "RELEASED",
        correlationId: input.correlationId,
      });
      await this.store.finish({
        context,
        invocationId,
        status: uncertain ? "UNCERTAIN" : "FAILED",
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
        correlationId: input.correlationId,
      });
      return { kind: result.kind, researchRequestId: authorized.researchRequestId };
    }
    const costMicros = Math.ceil(
      this.config.toolCostMicros +
        result.inputTokens * this.config.inputUsdPerMillion +
        result.outputTokens * this.config.outputUsdPerMillion,
    );
    await this.budgets.reconcile({
      organizationId: principal.organizationId,
      reservationId: reservation.reservationId,
      outcome: "CONSUMED",
      actualCostMicros: costMicros,
      correlationId: input.correlationId,
    });
    const valid = validateBoundedResearch(result.output, context);
    const completed = await this.store.finish({
      context,
      invocationId,
      status: valid ? "SUCCEEDED" : "INVALID",
      result: valid ? (result.output as BoundedResearchV1) : undefined,
      providerResponseId: result.responseId,
      errorCode: valid ? undefined : "model_output_invalid",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros,
      latencyMs: result.latencyMs,
      correlationId: input.correlationId,
    });
    return {
      kind: completed.status === "SUCCEEDED" ? ("completed" as const) : ("invalid" as const),
      researchRequestId: authorized.researchRequestId,
      claimIds: completed.claimIds,
    };
  }
}
