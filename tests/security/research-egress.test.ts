import { describe, expect, it, vi } from "vitest";
import { SafeWebResearchPort } from "../../apps/worker/src/research";

describe("research egress boundary", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"])(
    "rejects non-public address %s before making a request",
    async (address) => {
      const request = vi.fn();
      const port = new SafeWebResearchPort(
        async () => [],
        request,
        async () => [{ address }],
      );
      await expect(port.read("https://example.invalid/evidence")).rejects.toThrow(
        "research_egress_address_rejected",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});
