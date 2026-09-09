import { describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "../../packages/operations/src";

describe("operational foundation", () => {
  it("validates runtime configuration", () => {
    expect(() => loadConfig({ DATABASE_URL: "https://example.com" })).toThrow();
    expect(
      loadConfig({
        APP_ROLE: "worker",
        DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
        NODE_ENV: "test",
      }),
    ).toMatchObject({ APP_ROLE: "worker", NODE_ENV: "test", PORT: 3000 });
  });

  it("drops secrets and personal data from structured logs", () => {
    const output: string[] = [];
    const logger = createLogger("worker", "test", "debug", (line) => output.push(line));

    logger.write("error", {
      event: "provider_failed",
      correlationId: "correlation-123",
      errorCode: "provider_timeout",
      email: "person@example.com",
      phone: "+51999999999",
      token: "sentinel-secret-token",
      message: "private message",
    });

    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("person@example.com");
    expect(output[0]).not.toContain("+51999999999");
    expect(output[0]).not.toContain("sentinel-secret-token");
    expect(output[0]).not.toContain("private message");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      event: "provider_failed",
      correlationId: "correlation-123",
      errorCode: "provider_timeout",
    });
  });
});
