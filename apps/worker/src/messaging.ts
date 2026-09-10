import type { DeliveryResult, MessagingStore, OutboxMessage } from "@grausvera/database";

export interface MessagingPort {
  send(message: OutboxMessage): Promise<DeliveryResult>;
}

export class FakeMessagingPort implements MessagingPort {
  readonly sent: OutboxMessage[] = [];
  readonly #results: DeliveryResult[];

  constructor(results: DeliveryResult[] = []) {
    this.#results = [...results];
  }

  async send(message: OutboxMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return this.#results.shift() ?? { kind: "accepted", externalId: `fake-${message.id}` };
  }
}

export class MetaMessagingPort implements MessagingPort {
  constructor(
    private readonly options: {
      accessToken: string;
      baseUrl: string;
      phoneNumberId: string;
      timeoutMs: number;
    },
  ) {}

  async send(message: OutboxMessage): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(
        `${this.options.baseUrl}/${this.options.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(message.payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return response.status >= 400 && response.status < 500 && response.status !== 429
          ? { kind: "rejected", errorCode: `meta_http_${response.status}`, retryable: false }
          : { kind: "uncertain", errorCode: `meta_http_${response.status}` };
      }
      const body = (await response.json()) as { messages?: Array<{ id?: string }> };
      const externalId = body.messages?.[0]?.id;
      return externalId
        ? { kind: "accepted", externalId }
        : { kind: "uncertain", errorCode: "meta_response_invalid" };
    } catch {
      return { kind: "uncertain", errorCode: "meta_response_unknown" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OutboxDispatcher {
  #enabled = false;

  constructor(
    private readonly store: MessagingStore,
    private readonly port: MessagingPort,
  ) {}

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  async dispatchOne(): Promise<"disabled" | "idle" | DeliveryResult> {
    if (!this.#enabled) return "disabled";
    const message = await this.store.claimNext();
    if (!message) return "idle";
    if (!this.#enabled) {
      await this.store.finish(message, {
        kind: "rejected",
        errorCode: "emitter_disabled",
        retryable: true,
      });
      return "disabled";
    }
    const result = await this.port.send(message);
    await this.store.finish(message, result);
    return result;
  }
}
