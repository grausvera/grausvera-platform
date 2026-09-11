import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  ClaimedVerificationEmail,
  EmailDeliveryResult,
  EmailSecretSealer,
  EmailVerificationOutboxStore,
  SealedEmailSecret,
} from "@grausvera/database";

interface VerificationSecret {
  to: string;
  verificationUrl: string;
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

  open(item: ClaimedVerificationEmail): VerificationSecret {
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
    const value = JSON.parse(cleartext) as Partial<VerificationSecret>;
    if (!value.to || !value.verificationUrl) throw new Error("email_secret_invalid");
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
