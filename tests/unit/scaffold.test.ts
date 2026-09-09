import { describe, expect, it } from "vitest";
import { platformName } from "../../packages/shared/src";

describe("scaffold entries", () => {
  it("exports the shared platform identity", () => {
    expect(platformName).toBe("Grausvera Platform");
  });
});
