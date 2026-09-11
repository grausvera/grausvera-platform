import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type {
  BriefDeliveryService,
  ClaimedBriefDelivery,
  ClaimedVerificationEmail,
  EmailDeliveryResult,
  EmailDeliveryStore,
  EmailSecretSealer,
  EmailVerificationOutboxStore,
  ObjectPort,
  SealedEmailSecret,
} from "@grausvera/database";

interface VerificationSecret {
  to: string;
  verificationUrl: string;
}

export type SendTransactionalEmailV1 =
  | {
      purpose: "EMAIL_VERIFICATION";
      organizationId: string;
      caseId: string;
      contactPointId: string;
      challengeId: string;
      secretReference: string;
      templateId: "email-verification";
      templateVersion: 1;
      idempotencyKey: string;
      deadlineAt: string;
    }
  | {
      purpose: "BRIEF_DELIVERY";
      organizationId: string;
      caseId: string;
      contactPointId: string;
      approvalId: string;
      briefRevisionId: string;
      representationReference: string;
      representationHash: string;
      templateId: "brief-delivery";
      templateVersion: 1;
      idempotencyKey: string;
      deadlineAt: string;
    };

export function validateSendTransactionalEmailV1(
  value: unknown,
): value is SendTransactionalEmailV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const common = [
    "purpose",
    "organizationId",
    "caseId",
    "contactPointId",
    "templateId",
    "templateVersion",
    "idempotencyKey",
    "deadlineAt",
  ];
  if (
    common.some((key) => item[key] === undefined) ||
    common
      .filter((key) => key !== "templateVersion")
      .some((key) => typeof item[key] !== "string") ||
    item.templateVersion !== 1 ||
    Number.isNaN(Date.parse(String(item.deadlineAt)))
  ) {
    return false;
  }
  const purposeFields =
    item.purpose === "EMAIL_VERIFICATION"
      ? ["challengeId", "secretReference"]
      : item.purpose === "BRIEF_DELIVERY"
        ? ["approvalId", "briefRevisionId", "representationReference", "representationHash"]
        : undefined;
  if (!purposeFields || purposeFields.some((key) => typeof item[key] !== "string")) return false;
  if (item.purpose === "BRIEF_DELIVERY" && !/^[0-9a-f]{64}$/.test(String(item.representationHash)))
    return false;
  const expected = new Set([...common, ...purposeFields]);
  if (Object.keys(item).some((key) => !expected.has(key))) return false;
  return item.purpose === "EMAIL_VERIFICATION"
    ? item.templateId === "email-verification"
    : item.templateId === "brief-delivery";
}

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  tags: Array<{ name: string; value: string }>;
}

export interface EmailPort {
  send(email: TransactionalEmail): Promise<EmailDeliveryResult>;
}

export class AesGcmEmailSecretCodec implements EmailSecretSealer {
  readonly #key: Buffer;

  constructor(
    key: Uint8Array,
    readonly keyReference: string,
  ) {
    if (key.byteLength !== 32) throw new Error("email_secret_key_must_be_32_bytes");
    this.#key = Buffer.from(key);
  }

  seal(value: VerificationSecret): SealedEmailSecret {
    return this.#sealValue(value);
  }

  sealDestination(to: string): SealedEmailSecret {
    return this.#sealValue({ to });
  }

  #sealValue(value: { to: string; verificationUrl?: string }): SealedEmailSecret {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, initializationVector);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext,
      initializationVector,
      authenticationTag: cipher.getAuthTag(),
      keyReference: this.keyReference,
    };
  }

  openDestination(item: ClaimedBriefDelivery): string {
    return this.#openValue(item).to;
  }

  open(item: ClaimedVerificationEmail): VerificationSecret {
    const value = this.#openValue(item);
    if (!value.verificationUrl) throw new Error("email_secret_invalid");
    return { to: value.to, verificationUrl: value.verificationUrl };
  }

  #openValue(item: {
    keyReference: string;
    initializationVector: Uint8Array;
    authenticationTag: Uint8Array;
    ciphertext: Uint8Array;
  }): { to: string; verificationUrl?: string } {
    if (item.keyReference !== this.keyReference) throw new Error("email_secret_key_unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(item.initializationVector),
    );
    decipher.setAuthTag(Buffer.from(item.authenticationTag));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    const value = JSON.parse(cleartext) as { to?: unknown; verificationUrl?: unknown };
    if (
      typeof value.to !== "string" ||
      (value.verificationUrl !== undefined && typeof value.verificationUrl !== "string")
    )
      throw new Error("email_secret_invalid");
    return { to: value.to, verificationUrl: value.verificationUrl };
  }
}

export class FakeEmailPort implements EmailPort {
  readonly sent: TransactionalEmail[] = [];
  readonly #results: EmailDeliveryResult[];

  constructor(results: EmailDeliveryResult[] = []) {
    this.#results = [...results];
  }

  async send(email: TransactionalEmail): Promise<EmailDeliveryResult> {
    this.sent.push(email);
    return this.#results.shift() ?? { kind: "accepted", externalId: `fake-${this.sent.length}` };
  }
}

export class ResendEmailPort implements EmailPort {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      from: string;
      timeoutMs: number;
    },
  ) {}

  async send(email: TransactionalEmail): Promise<EmailDeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
          tags: email.tags,
          headers: { "X-Entity-Ref-ID": email.idempotencyKey },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return response.status >= 400 && response.status < 500 && response.status !== 429
          ? { kind: "rejected", errorCode: `resend_http_${response.status}`, retryable: false }
          : { kind: "uncertain", errorCode: `resend_http_${response.status}` };
      }
      const body = (await response.json()) as { id?: string };
      return body.id
        ? { kind: "accepted", externalId: body.id }
        : { kind: "uncertain", errorCode: "resend_response_invalid" };
    } catch {
      return { kind: "uncertain", errorCode: "resend_response_unknown" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function renderEmailVerification(secret: VerificationSecret): TransactionalEmail {
  const escapedUrl = escapeHtml(secret.verificationUrl);
  return {
    to: secret.to,
    subject: "Verifica tu correo para continuar",
    text: `Verifica tu correo para continuar con tu solicitud en grausvera:\n\n${secret.verificationUrl}\n\nSi no solicitaste este mensaje, puedes ignorarlo.`,
    html: `<p>Verifica tu correo para continuar con tu solicitud en grausvera.</p><p><a href="${escapedUrl}">Verificar correo</a></p><p>Si no solicitaste este mensaje, puedes ignorarlo.</p>`,
    idempotencyKey: "",
    tags: [{ name: "purpose", value: "email_verification" }],
  };
}

export function renderBriefDelivery(to: string, representation: unknown): TransactionalEmail {
  const text = JSON.stringify(representation, null, 2);
  return {
    to,
    subject: "Tu brief de descubrimiento está listo",
    text: `Este es el brief de descubrimiento aprobado para tu solicitud en grausvera.\n\n${text}`,
    html: `<p>Este es el brief de descubrimiento aprobado para tu solicitud en grausvera.</p><pre>${escapeHtml(text)}</pre>`,
    idempotencyKey: "",
    tags: [{ name: "purpose", value: "brief_delivery" }],
  };
}

export class BriefDeliveryDispatcher {
  #enabled = false;

  constructor(
    private readonly service: BriefDeliveryService,
    private readonly deliveries: EmailDeliveryStore,
    private readonly objects: ObjectPort,
    private readonly port: EmailPort,
    private readonly codec: AesGcmEmailSecretCodec,
  ) {}

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
  }

  async dispatchOne(): Promise<"disabled" | "idle" | "cancelled" | EmailDeliveryResult> {
    if (!this.#enabled) return "disabled";
    const deliveryId = await this.service.nextPreparedId();
    if (!deliveryId) return "idle";
    const attempt = await this.deliveries.startAttempt(deliveryId);
    if (!attempt) return "idle";
    const item = await this.service.loadClaimed(deliveryId);
    if (!item || !(await this.service.authorize(item))) {
      const rejected = {
        kind: "rejected",
        errorCode: "delivery_not_authorized",
        retryable: false,
      } as const;
      await this.deliveries.finishAttempt(deliveryId, attempt.attemptNumber, rejected);
      await this.service.destroySecret(deliveryId);
      return "cancelled";
    }
    let result: EmailDeliveryResult;
    try {
      const bytes = await this.objects.get(item.representationReference);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== item.representationHash) throw new Error("representation_hash_mismatch");
      const representation = JSON.parse(new TextDecoder().decode(bytes)) as {
        briefRevisionId?: unknown;
        snapshotHash?: unknown;
      };
      if (
        representation.briefRevisionId !== item.briefRevisionId ||
        representation.snapshotHash !== item.snapshotHash
      )
        throw new Error("representation_scope_mismatch");
      const email = renderBriefDelivery(this.codec.openDestination(item), representation);
      email.idempotencyKey = item.idempotencyKey;
      result = await this.port.send(email);
    } catch {
      result = { kind: "rejected", errorCode: "delivery_representation_invalid", retryable: false };
    }
    await this.deliveries.finishAttempt(deliveryId, attempt.attemptNumber, result);
    if (result.kind === "accepted" || (result.kind === "rejected" && !result.retryable))
      await this.service.destroySecret(deliveryId);
    return result;
  }
}

export class EmailOutboxDispatcher {
  #enabled = false;

  constructor(
    private readonly store: EmailVerificationOutboxStore,
    private readonly port: EmailPort,
    private readonly codec: AesGcmEmailSecretCodec,
  ) {}

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
  }

  async dispatchOne(): Promise<"disabled" | "idle" | "cancelled" | EmailDeliveryResult> {
    if (!this.#enabled) return "disabled";
    const item = await this.store.claimNext();
    if (!item) return "idle";
    if (!(await this.store.authorizeDispatch(item))) return "cancelled";
    let result: EmailDeliveryResult;
    try {
      const email = renderEmailVerification(this.codec.open(item));
      email.idempotencyKey = item.idempotencyKey;
      result = await this.port.send(email);
    } catch {
      result = { kind: "rejected", errorCode: "email_secret_unavailable", retryable: false };
    }
    await this.store.finish(item, result);
    return result;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
