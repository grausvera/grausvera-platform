import type { OperationalInspection } from "@grausvera/database";

export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
export const ABANDONED_RESERVATION_MS = 15 * 60 * 1000;

export interface ReconciliationCapabilities {
  messaging: {
    markAbandonedDispatchesUncertain(cutoff: Date): Promise<number>;
    releaseAbandonedInbox(cutoff: Date): Promise<number>;
  };
  verificationEmail: { markAbandonedDispatchesUncertain(cutoff: Date): Promise<number> };
  deliveryEmail: {
    reconcileUnmatched(): Promise<number>;
    expireUnreconciled(now: Date): Promise<number>;
  };
  budget: { markAbandonedReservationsUncertain(cutoff: Date): Promise<number> };
  inspection: { inspect(cutoff: Date): Promise<OperationalInspection> };
}

export interface ReconciliationResult {
  abandonedMessaging: number;
  abandonedVerificationEmail: number;
  releasedInbox: number;
  reconciledEmail: number;
  expiredDeliveries: number;
  abandonedReservations: number;
  inspection: OperationalInspection;
}

export async function reconcileOperationalState(
  capabilities: ReconciliationCapabilities,
  now = new Date(),
): Promise<ReconciliationResult> {
  const reconciliationCutoff = new Date(now.getTime() - RECONCILIATION_INTERVAL_MS);
  const reservationCutoff = new Date(now.getTime() - ABANDONED_RESERVATION_MS);
  const abandonedMessaging =
    await capabilities.messaging.markAbandonedDispatchesUncertain(reconciliationCutoff);
  const abandonedVerificationEmail =
    await capabilities.verificationEmail.markAbandonedDispatchesUncertain(reconciliationCutoff);
  const releasedInbox = await capabilities.messaging.releaseAbandonedInbox(reconciliationCutoff);
  const reconciledEmail = await capabilities.deliveryEmail.reconcileUnmatched();
  const expiredDeliveries = await capabilities.deliveryEmail.expireUnreconciled(now);
  const abandonedReservations =
    await capabilities.budget.markAbandonedReservationsUncertain(reservationCutoff);
  const inspection = await capabilities.inspection.inspect(reconciliationCutoff);
  return {
    abandonedMessaging,
    abandonedVerificationEmail,
    releasedInbox,
    reconciledEmail,
    expiredDeliveries,
    abandonedReservations,
    inspection,
  };
}
