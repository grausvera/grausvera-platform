import { describe, expect, it, vi } from "vitest";
import {
  ABANDONED_RESERVATION_MS,
  reconcileOperationalState,
  RECONCILIATION_INTERVAL_MS,
} from "../../apps/worker/src/reconciliation";

describe("operational reconciliation coordinator", () => {
  it("runs existing capabilities in order and exposes actionable aggregate state", async () => {
    const calls: string[] = [];
    const now = new Date("2026-09-11T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - RECONCILIATION_INTERVAL_MS);
    const reservationCutoff = new Date(now.getTime() - ABANDONED_RESERVATION_MS);
    const capabilities = {
      messaging: {
        markAbandonedDispatchesUncertain: vi.fn(async (at: Date) => {
          calls.push(`messaging:${at.toISOString()}`);
          return 1;
        }),
        releaseAbandonedInbox: vi.fn(async (at: Date) => {
          calls.push(`inbox:${at.toISOString()}`);
          return 2;
        }),
      },
      verificationEmail: {
        markAbandonedDispatchesUncertain: vi.fn(async (at: Date) => {
          calls.push(`verification:${at.toISOString()}`);
          return 3;
        }),
      },
      deliveryEmail: {
        reconcileUnmatched: vi.fn(async () => {
          calls.push("email-reconcile");
          return 4;
        }),
        expireUnreconciled: vi.fn(async (at: Date) => {
          calls.push(`email-expire:${at.toISOString()}`);
          return 5;
        }),
      },
      budget: {
        markAbandonedReservationsUncertain: vi.fn(async (at: Date) => {
          calls.push(`budget:${at.toISOString()}`);
          return 6;
        }),
      },
      inspection: {
        inspect: vi.fn(async (at: Date) => {
          calls.push(`inspect:${at.toISOString()}`);
          return {
            pendingInbox: 0,
            uncertainOutbox: 1,
            actionOutbox: 1,
            uncertainDeliveries: 0,
            uncertainReservations: 1,
            actions: ["RECONCILE_PROVIDER_EFFECT", "RECONCILE_PROVIDER_USAGE", "OPERATOR_REVIEW"],
          };
        }),
      },
    };

    const result = await reconcileOperationalState(capabilities, now);

    expect(result).toMatchObject({
      abandonedMessaging: 1,
      abandonedVerificationEmail: 3,
      releasedInbox: 2,
      reconciledEmail: 4,
      expiredDeliveries: 5,
      abandonedReservations: 6,
    });
    expect(calls).toEqual([
      `messaging:${cutoff.toISOString()}`,
      `verification:${cutoff.toISOString()}`,
      `inbox:${cutoff.toISOString()}`,
      "email-reconcile",
      `email-expire:${now.toISOString()}`,
      `budget:${reservationCutoff.toISOString()}`,
      `inspect:${cutoff.toISOString()}`,
    ]);
  });
});
