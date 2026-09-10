import { describe, expect, it } from "vitest";
import { classifyConversationIntervention } from "../../packages/database/src/intervention";

describe("conversation intervention classifier", () => {
  it("recognizes only the documented stop phrases", () => {
    expect(classifyConversationIntervention("  detener ")).toBe("STOP");
    expect(classifyConversationIntervention("NO   QUIERO continuar")).toBe("STOP");
    expect(classifyConversationIntervention("quiero detenerme")).toBe("STOP");
  });

  it("recognizes only the documented human assistance phrases", () => {
    expect(classifyConversationIntervention("ayuda humana")).toBe("HUMAN_REQUEST");
    expect(classifyConversationIntervention("QUIERO HABLAR CON UNA PERSONA")).toBe("HUMAN_REQUEST");
  });

  it("leaves ambiguous conversation text without effects", () => {
    expect(classifyConversationIntervention("ayuda")).toBeUndefined();
    expect(classifyConversationIntervention("quizá luego")).toBeUndefined();
    expect(classifyConversationIntervention("no quiero continuar con este tema")).toBeUndefined();
  });
});
