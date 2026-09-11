import { describe, expect, it } from "vitest";
import { classifyCaseAssociationIntent } from "../../packages/database/src";

describe("case association intent", () => {
  it("creates a case only from a narrow explicit instruction", () => {
    expect(classifyCaseAssociationIntent("nuevo proyecto")).toBe("NEW_CASE");
    expect(classifyCaseAssociationIntent("Quiero iniciar un nuevo proyecto.")).toBe("NEW_CASE");
    expect(classifyCaseAssociationIntent("tengo otra idea")).toBe("UNRESOLVED");
    expect(classifyCaseAssociationIntent("continuemos")).toBe("UNRESOLVED");
  });
});
