import { describe, expect, it } from "vitest";
import { availableBudget } from "../../packages/database/src/budget";

describe("budget availability", () => {
  it("subtracts consumed, reserved, and uncertain cost from the same ceiling", () => {
    expect(
      availableBudget({
        hardLimitMicros: 500_000,
        consumedMicros: 100_000,
        reservedMicros: 150_000,
        uncertainMicros: 200_000,
      }),
    ).toBe(50_000);
  });

  it("never exposes negative spendable balance", () => {
    expect(
      availableBudget({
        hardLimitMicros: 500_000,
        consumedMicros: 510_000,
        reservedMicros: 0,
        uncertainMicros: 0,
      }),
    ).toBe(0);
  });
});
