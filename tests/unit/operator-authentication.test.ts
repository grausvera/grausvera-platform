import { describe, expect, it } from "vitest";
import {
  APPROVAL_REAUTHENTICATION_MAX_AGE_MS,
  assertRecentAuthentication,
} from "../../apps/web/lib/operator-session";

describe("approval authentication freshness", () => {
  const now = new Date("2026-09-10T12:00:00.000Z");

  it("accepts a recently created fully verified session", () => {
    expect(() => assertRecentAuthentication(new Date(now.getTime() - 60_000), now)).not.toThrow();
  });

  it("rejects an old or future authentication time", () => {
    expect(() =>
      assertRecentAuthentication(
        new Date(now.getTime() - APPROVAL_REAUTHENTICATION_MAX_AGE_MS),
        now,
      ),
    ).toThrow("operator_recent_authentication_required");
    expect(() => assertRecentAuthentication(new Date(now.getTime() + 1), now)).toThrow(
      "operator_recent_authentication_required",
    );
  });
});
