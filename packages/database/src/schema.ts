import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const version = integer("version").default(1).notNull();
const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const contactKind = pgEnum("contact_kind", ["WHATSAPP", "EMAIL"]);
export const participantRole = pgEnum("participant_role", [
  "REQUESTER",
  "REPRESENTATIVE",
  "DECISION_MAKER",
  "COLLABORATOR",
  "OPERATOR",
]);
export const caseStatus = pgEnum("case_status", [
  "NEW",
  "AWAITING_CONSENT",
  "INTERVIEWING",
  "PAUSED",
  "NEEDS_INFORMATION",
  "READY_FOR_SYNTHESIS",
  "SYNTHESIZING",
  "ENGINEER_REVIEW",
  "AWAITING_EMAIL_VERIFICATION",
  "PROSPECT_CONFIRMATION",
  "QUALIFIED",
  "NOT_A_FIT",
  "CLOSED",
]);
export const providerKind = pgEnum("provider_kind", ["WHATSAPP", "EMAIL", "MODEL", "OBJECT"]);
export const auditResult = pgEnum("audit_result", ["SUCCEEDED", "REJECTED", "FAILED"]);
export const inboxStatus = pgEnum("inbox_status", [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "NEEDS_ACTION",
]);
export const messageDirection = pgEnum("message_direction", ["INBOUND", "OUTBOUND"]);
export const messageProcessingStatus = pgEnum("message_processing_status", [
  "RECEIVED",
  "PROCESSED",
  "FAILED",
  "NEEDS_ACTION",
]);
export const outboxStatus = pgEnum("outbox_status", [
  "PENDING",
  "DISPATCHING",
  "ACCEPTED",
  "UNCERTAIN",
  "NEEDS_ACTION",
  "FAILED",
  "CANCELLED",
]);
export const deliveryAttemptOutcome = pgEnum("delivery_attempt_outcome", [
  "ACCEPTED",
  "REJECTED_TRANSIENT",
  "REJECTED_PERMANENT",
  "UNCERTAIN",
]);
export const inboxItemKind = pgEnum("inbox_item_kind", ["MESSAGE", "STATUS", "UNSUPPORTED"]);
export const inboxItemStatus = pgEnum("inbox_item_status", [
  "PENDING",
  "ASSOCIATED",
  "AMBIGUOUS",
  "UNMATCHED",
  "PROCESSED",
]);
export const providerDeliveryStatus = pgEnum("provider_delivery_status", [
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "DELETED",
]);
export const consentPurpose = pgEnum("consent_purpose", ["DISCOVERY"]);
export const consentAction = pgEnum("consent_action", ["ACCEPTED", "REJECTED", "REVOKED"]);
export const consentScope = pgEnum("consent_scope", ["PROJECT_DISCOVERY"]);
export const consentRequestStatus = pgEnum("consent_request_status", [
  "PENDING",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
]);
export const conversationInterventionKind = pgEnum("conversation_intervention_kind", [
  "STOP",
  "HUMAN_REQUEST",
]);
export const budgetReservationStatus = pgEnum("budget_reservation_status", [
  "RESERVED",
  "CONSUMED",
  "RELEASED",
  "UNCERTAIN",
  "REJECTED",
]);
export const attachmentStatus = pgEnum("attachment_status", [
  "QUARANTINED",
  "REVIEWED",
  "REJECTED",
]);
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    check("organizations_r1_operator_only", sql`${t.slug} = 'grausvera'`),
    check("organizations_version_positive", sql`${t.version} > 0`),
  ],
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("people_membership_unique").on(t.organizationId, t.id),
    check("people_version_positive", sql`${t.version} > 0`),
  ],
);

export const contactPoints = pgTable(
  "contact_points",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: contactKind("kind").notNull(),
    valueCiphertext: text("value_ciphertext").notNull(),
    fingerprint: text("fingerprint").notNull(),
    source: text("source").notNull(),
    purpose: text("purpose").notNull(),
    provider: text("provider"),
    externalId: text("external_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.personId],
      foreignColumns: [people.organizationId, people.id],
      name: "contact_points_person_membership_fk",
    }).onDelete("restrict"),
    unique("contact_points_membership_unique").on(t.organizationId, t.id),
    unique("contact_points_person_membership_unique").on(t.organizationId, t.personId, t.id),
    uniqueIndex("contact_points_fingerprint_unique").on(t.organizationId, t.kind, t.fingerprint),
    uniqueIndex("contact_points_provider_external_unique")
      .on(t.organizationId, t.kind, t.provider, t.externalId)
      .where(sql`${t.provider} is not null and ${t.externalId} is not null`),
    check("contact_points_ciphertext_not_empty", sql`length(${t.valueCiphertext}) > 0`),
    check("contact_points_fingerprint_not_empty", sql`length(${t.fingerprint}) > 0`),
    check("contact_points_version_positive", sql`${t.version} > 0`),
  ],
);

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: providerKind("kind").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    credentialReference: text("credential_reference").notNull(),
    configuration: jsonb("configuration").default({}).notNull(),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("provider_connections_membership_unique").on(t.organizationId, t.id),
    uniqueIndex("provider_connections_account_unique").on(
      t.organizationId,
      t.kind,
      t.externalAccountId,
    ),
    check(
      "provider_connections_credential_reference_not_empty",
      sql`length(${t.credentialReference}) > 0`,
    ),
    check("provider_connections_version_positive", sql`${t.version} > 0`),
  ],
);

export const prospectCases = pgTable(
  "prospect_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: caseStatus("status").default("NEW").notNull(),
    origin: text("origin"),
    campaign: text("campaign"),
    nextAction: text("next_action"),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("prospect_cases_membership_unique").on(t.organizationId, t.id),
    index("prospect_cases_status_idx").on(t.organizationId, t.status),
    check("prospect_cases_version_positive", sql`${t.version} > 0`),
  ],
);

export const caseParticipants = pgTable(
  "case_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    personId: uuid("person_id").notNull(),
    role: participantRole("role").notNull(),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "case_participants_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.personId],
      foreignColumns: [people.organizationId, people.id],
      name: "case_participants_person_membership_fk",
    }).onDelete("restrict"),
    uniqueIndex("case_participants_role_unique").on(t.organizationId, t.caseId, t.personId, t.role),
    check("case_participants_version_positive", sql`${t.version} > 0`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    providerConnectionId: uuid("provider_connection_id").notNull(),
    channel: contactKind("channel").default("WHATSAPP").notNull(),
    externalThreadId: text("external_thread_id"),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "conversations_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.providerConnectionId],
      foreignColumns: [providerConnections.organizationId, providerConnections.id],
      name: "conversations_connection_membership_fk",
    }).onDelete("restrict"),
    unique("conversations_membership_unique").on(t.organizationId, t.id),
    uniqueIndex("conversations_thread_unique")
      .on(t.providerConnectionId, t.externalThreadId)
      .where(sql`${t.externalThreadId} is not null`),
    check("conversations_whatsapp_only", sql`${t.channel} = 'WHATSAPP'`),
    check("conversations_version_positive", sql`${t.version} > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    caseId: uuid("case_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    expectedVersion: integer("expected_version"),
    result: auditResult("result").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    origin: text("origin").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "audit_events_case_membership_fk",
    }).onDelete("restrict"),
    index("audit_events_correlation_idx").on(t.organizationId, t.correlationId),
    check("audit_events_action_not_empty", sql`length(${t.action}) > 0`),
    check("audit_events_resource_type_not_empty", sql`length(${t.resourceType}) > 0`),
    check("audit_events_origin_not_empty", sql`length(${t.origin}) > 0`),
    check(
      "audit_events_expected_version_positive",
      sql`${t.expectedVersion} is null or ${t.expectedVersion} > 0`,
    ),
  ],
);

export const authUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  twoFactorEnabled: boolean("twoFactorEnabled"),
});

export const authSessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const authVerifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const authTwoFactors = pgTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    verified: boolean("verified"),
    failedVerificationCount: integer("failedVerificationCount"),
    lockedUntil: timestamp("lockedUntil", { withTimezone: true }),
  },
  (t) => [index("twoFactor_secret_idx").on(t.secret), index("twoFactor_userId_idx").on(t.userId)],
);

export const operatorMemberships = pgTable(
  "operator_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").default("ENGINEER").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt,
  },
  (t) => [
    unique("operator_memberships_unique").on(t.organizationId, t.userId),
    index("operator_memberships_user_idx").on(t.userId, t.active),
    check("operator_memberships_role_check", sql`${t.role} = 'ENGINEER'`),
  ],
);

export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    providerConnectionId: uuid("provider_connection_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    payloadBytes: bytea("payload_bytes").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: inboxStatus("status").default("RECEIVED").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.providerConnectionId],
      foreignColumns: [providerConnections.organizationId, providerConnections.id],
      name: "inbox_events_connection_membership_fk",
    }).onDelete("restrict"),
    unique("inbox_events_external_unique").on(t.providerConnectionId, t.externalEventId),
    index("inbox_events_pending_idx").on(t.status, t.receivedAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    providerConnectionId: uuid("provider_connection_id").notNull(),
    direction: messageDirection("direction").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    messageType: text("message_type").notNull(),
    contentBytes: bytea("content_bytes"),
    contentHash: text("content_hash"),
    providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processingStatus: messageProcessingStatus("processing_status").default("RECEIVED").notNull(),
    senderPersonId: uuid("sender_person_id"),
    senderContactPointId: uuid("sender_contact_point_id"),
    replyToProviderMessageId: text("reply_to_provider_message_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "messages_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "messages_conversation_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.providerConnectionId],
      foreignColumns: [providerConnections.organizationId, providerConnections.id],
      name: "messages_connection_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.senderPersonId, t.senderContactPointId],
      foreignColumns: [contactPoints.organizationId, contactPoints.personId, contactPoints.id],
      name: "messages_sender_contact_fk",
    }).onDelete("restrict"),
    unique("messages_provider_unique").on(t.providerConnectionId, t.providerMessageId),
    unique("messages_case_membership_unique").on(t.organizationId, t.caseId, t.id),
    index("messages_conversation_order_idx").on(
      t.organizationId,
      t.conversationId,
      t.providerOccurredAt,
      t.receivedAt,
    ),
    index("messages_reply_idx")
      .on(t.providerConnectionId, t.replyToProviderMessageId)
      .where(sql`${t.replyToProviderMessageId} is not null`),
  ],
);

export const conversationInterventions = pgTable(
  "conversation_interventions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    personId: uuid("person_id").notNull(),
    contactPointId: uuid("contact_point_id").notNull(),
    sourceMessageId: uuid("source_message_id").notNull(),
    kind: conversationInterventionKind("kind").notNull(),
    createdAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "conversation_interventions_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.caseId, t.sourceMessageId],
      foreignColumns: [messages.organizationId, messages.caseId, messages.id],
      name: "conversation_interventions_source_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.personId, t.contactPointId],
      foreignColumns: [contactPoints.organizationId, contactPoints.personId, contactPoints.id],
      name: "conversation_interventions_contact_fk",
    }).onDelete("restrict"),
    unique("conversation_interventions_source_unique").on(t.organizationId, t.sourceMessageId),
    index("conversation_interventions_case_idx").on(t.organizationId, t.caseId, t.createdAt),
  ],
);

export const operatorCaseAssignments = pgTable(
  "operator_case_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    userId: text("user_id").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "operator_case_assignments_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.userId],
      foreignColumns: [operatorMemberships.organizationId, operatorMemberships.userId],
      name: "operator_case_assignments_membership_fk",
    }).onDelete("restrict"),
    unique("operator_case_assignments_unique").on(t.organizationId, t.caseId),
    index("operator_case_assignments_user_idx").on(t.organizationId, t.userId, t.active),
  ],
);

export const quotaPolicies = pgTable(
  "quota_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    periodSeconds: integer("period_seconds").notNull(),
    caseMessageLimit: integer("case_message_limit").notNull(),
    contactMessageLimit: integer("contact_message_limit").notNull(),
    caseActiveSecondsLimit: integer("case_active_seconds_limit").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt,
  },
  (t) => [
    unique("quota_policies_version_unique").on(t.organizationId, t.version),
    index("quota_policies_effective_idx").on(t.organizationId, t.effectiveAt),
    check(
      "quota_policies_limits_positive",
      sql`${t.version} > 0 and ${t.periodSeconds} > 0 and ${t.caseMessageLimit} > 0 and ${t.contactMessageLimit} > 0 and ${t.caseActiveSecondsLimit} > 0`,
    ),
  ],
);

export const caseQuotaUsages = pgTable(
  "case_quota_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => quotaPolicies.id, { onDelete: "restrict" }),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").default(0).notNull(),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    lastAccountedAt: timestamp("last_accounted_at", { withTimezone: true }).defaultNow().notNull(),
    exceededAt: timestamp("exceeded_at", { withTimezone: true }),
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "case_quota_usages_case_fk",
    }).onDelete("restrict"),
    unique("case_quota_usages_unique").on(t.organizationId, t.caseId, t.policyId),
    index("case_quota_usages_window_idx").on(t.organizationId, t.windowEndsAt),
    check("case_quota_usages_nonnegative", sql`${t.messageCount} >= 0 and ${t.activeSeconds} >= 0`),
    check("case_quota_usages_window_valid", sql`${t.windowEndsAt} > ${t.windowStartedAt}`),
  ],
);

export const contactQuotaUsages = pgTable(
  "contact_quota_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    contactPointId: uuid("contact_point_id").notNull(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => quotaPolicies.id, { onDelete: "restrict" }),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").default(0).notNull(),
    exceededAt: timestamp("exceeded_at", { withTimezone: true }),
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.contactPointId],
      foreignColumns: [contactPoints.organizationId, contactPoints.id],
      name: "contact_quota_usages_contact_fk",
    }).onDelete("restrict"),
    unique("contact_quota_usages_unique").on(t.organizationId, t.contactPointId, t.policyId),
    index("contact_quota_usages_window_idx").on(t.organizationId, t.windowEndsAt),
    check("contact_quota_usages_nonnegative", sql`${t.messageCount} >= 0`),
    check("contact_quota_usages_window_valid", sql`${t.windowEndsAt} > ${t.windowStartedAt}`),
  ],
);

export const quotaConsumptions = pgTable(
  "quota_consumptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "restrict" }),
    caseUsageId: uuid("case_usage_id")
      .notNull()
      .references(() => caseQuotaUsages.id, { onDelete: "restrict" }),
    contactUsageId: uuid("contact_usage_id")
      .notNull()
      .references(() => contactQuotaUsages.id, { onDelete: "restrict" }),
    exceeded: boolean("exceeded").default(false).notNull(),
    reason: text("reason"),
    createdAt,
  },
  (t) => [
    unique("quota_consumptions_message_unique").on(t.organizationId, t.messageId),
    check(
      "quota_consumptions_reason_check",
      sql`(${t.exceeded} and ${t.reason} is not null) or (not ${t.exceeded} and ${t.reason} is null)`,
    ),
  ],
);

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    currency: text("currency").default("USD").notNull(),
    alertMicros: bigint("alert_micros", { mode: "number" }).notNull(),
    hardLimitMicros: bigint("hard_limit_micros", { mode: "number" }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt,
  },
  (t) => [
    unique("budget_policies_version_unique").on(t.organizationId, t.version),
    unique("budget_policies_organization_id_unique").on(t.organizationId, t.id),
    index("budget_policies_effective_idx").on(t.organizationId, t.effectiveAt),
    check("budget_policies_currency_check", sql`${t.currency} = 'USD'`),
    check(
      "budget_policies_limits_check",
      sql`${t.version} > 0 and ${t.alertMicros} > 0 and ${t.hardLimitMicros} >= ${t.alertMicros}`,
    ),
  ],
);

export const budgetLedgers = pgTable(
  "budget_ledgers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    periodKey: text("period_key").default("R1_CASE_LIFETIME").notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).default(0).notNull(),
    consumedMicros: bigint("consumed_micros", { mode: "number" }).default(0).notNull(),
    uncertainMicros: bigint("uncertain_micros", { mode: "number" }).default(0).notNull(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "budget_ledgers_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.policyId],
      foreignColumns: [budgetPolicies.organizationId, budgetPolicies.id],
      name: "budget_ledgers_policy_fk",
    }).onDelete("restrict"),
    unique("budget_ledgers_unique").on(t.organizationId, t.caseId, t.periodKey),
    unique("budget_ledgers_organization_case_id_unique").on(t.organizationId, t.caseId, t.id),
    check(
      "budget_ledgers_nonnegative",
      sql`${t.reservedMicros} >= 0 and ${t.consumedMicros} >= 0 and ${t.uncertainMicros} >= 0`,
    ),
    check("budget_ledgers_period_check", sql`${t.periodKey} = 'R1_CASE_LIFETIME'`),
  ],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").notNull(),
    ledgerId: uuid("ledger_id").notNull(),
    stage: text("stage").notNull(),
    purpose: text("purpose").notNull(),
    logicalOperationKey: text("logical_operation_key").notNull(),
    attemptKey: text("attempt_key").notNull(),
    maximumCostMicros: bigint("maximum_cost_micros", { mode: "number" }).notNull(),
    actualCostMicros: bigint("actual_cost_micros", { mode: "number" }),
    status: budgetReservationStatus("status").notNull(),
    createdAt,
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "budget_reservations_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.caseId, t.ledgerId],
      foreignColumns: [budgetLedgers.organizationId, budgetLedgers.caseId, budgetLedgers.id],
      name: "budget_reservations_ledger_fk",
    }).onDelete("restrict"),
    unique("budget_reservations_attempt_unique").on(t.organizationId, t.attemptKey),
    index("budget_reservations_operation_idx").on(
      t.organizationId,
      t.caseId,
      t.logicalOperationKey,
    ),
    check(
      "budget_reservations_values_check",
      sql`${t.maximumCostMicros} > 0 and (${t.actualCostMicros} is null or ${t.actualCostMicros} >= 0)`,
    ),
    check("budget_reservations_stage_check", sql`length(${t.stage}) > 0`),
    check("budget_reservations_operation_check", sql`length(${t.logicalOperationKey}) > 0`),
    check(
      "budget_reservations_purpose_check",
      sql`${t.purpose} in ('INTERVIEW_EXTRACT', 'NEXT_QUESTION', 'BRIEF_SYNTHESIS', 'BOUNDED_RESEARCH')`,
    ),
  ],
);

export const attachmentCircuitBreakers = pgTable(
  "attachment_circuit_breakers",
  {
    organizationId: uuid("organization_id").notNull(),
    providerConnectionId: uuid("provider_connection_id").notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    openUntil: timestamp("open_until", { withTimezone: true }),
    probeInFlight: boolean("probe_in_flight").default(false).notNull(),
    updatedAt,
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.providerConnectionId],
      name: "attachment_circuit_breakers_pk",
    }),
    foreignKey({
      columns: [t.organizationId, t.providerConnectionId],
      foreignColumns: [providerConnections.organizationId, providerConnections.id],
      name: "attachment_circuit_breakers_provider_fk",
    }).onDelete("restrict"),
    check("attachment_circuit_breakers_failures_check", sql`${t.consecutiveFailures} >= 0`),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    mediaReferenceId: uuid("media_reference_id")
      .notNull()
      .references(() => mediaReferences.id, { onDelete: "restrict" }),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: attachmentStatus("status").default("QUARANTINED").notNull(),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "attachments_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.reviewedByUserId],
      foreignColumns: [operatorMemberships.organizationId, operatorMemberships.userId],
      name: "attachments_reviewer_fk",
    }).onDelete("restrict"),
    unique("attachments_media_unique").on(t.organizationId, t.mediaReferenceId),
    unique("attachments_object_key_unique").on(t.objectKey),
    index("attachments_review_queue_idx").on(t.organizationId, t.status, t.createdAt),
    check(
      "attachments_values_check",
      sql`${t.sizeBytes} > 0 and length(${t.objectKey}) > 0 and length(${t.sha256}) = 64`,
    ),
    check(
      "attachments_review_check",
      sql`(${t.status} = 'QUARANTINED' and ${t.reviewedByUserId} is null and ${t.reviewedAt} is null) or (${t.status} <> 'QUARANTINED' and ${t.reviewedByUserId} is not null and ${t.reviewedAt} is not null)`,
    ),
    check(
      "attachments_rejection_check",
      sql`(${t.status} = 'REJECTED' and ${t.rejectionReason} is not null) or (${t.status} <> 'REJECTED' and ${t.rejectionReason} is null)`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: outboxStatus("status").default("PENDING").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    providerExternalId: text("provider_external_id"),
    lastErrorCode: text("last_error_code"),
    authorizedOperatorUserId: text("authorized_operator_user_id"),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "outbox_events_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.authorizedOperatorUserId],
      foreignColumns: [operatorMemberships.organizationId, operatorMemberships.userId],
      name: "outbox_events_operator_membership_fk",
    }).onDelete("restrict"),
    unique("outbox_events_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    index("outbox_events_dispatch_idx").on(t.status, t.availableAt, t.createdAt),
  ],
);

export const messageDeliveryAttempts = pgTable(
  "message_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcome: deliveryAttemptOutcome("outcome"),
    providerExternalId: text("provider_external_id"),
    errorCode: text("error_code"),
  },
  (t) => [unique("message_delivery_attempts_number_unique").on(t.outboxEventId, t.attemptNumber)],
);

export const inboxEventItems = pgTable("inbox_event_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  inboxEventId: uuid("inbox_event_id")
    .notNull()
    .references(() => inboxEvents.id),
  organizationId: uuid("organization_id").notNull(),
  providerConnectionId: uuid("provider_connection_id").notNull(),
  itemKey: text("item_key").notNull(),
  kind: inboxItemKind("kind").notNull(),
  providerMessageId: text("provider_message_id"),
  senderExternalId: text("sender_external_id"),
  replyToProviderMessageId: text("reply_to_provider_message_id"),
  messageType: text("message_type"),
  textContent: text("text_content"),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }).notNull(),
  receivedOrdinal: integer("received_ordinal").notNull(),
  status: inboxItemStatus("status").default("PENDING").notNull(),
  caseId: uuid("case_id"),
  conversationId: uuid("conversation_id"),
  reasonCode: text("reason_code"),
  createdAt,
});

export const mediaReferences = pgTable("media_references", {
  id: uuid("id").defaultRandom().primaryKey(),
  inboxItemId: uuid("inbox_item_id")
    .notNull()
    .unique()
    .references(() => inboxEventItems.id),
  providerMediaId: text("provider_media_id").notNull(),
  mediaType: text("media_type").notNull(),
  mimeType: text("mime_type"),
  filename: text("filename"),
  sha256: text("sha256"),
  restricted: boolean("restricted").default(true).notNull(),
  createdAt,
});

export const messageStatusObservations = pgTable("message_status_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  providerConnectionId: uuid("provider_connection_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  status: providerDeliveryStatus("status").notNull(),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }).notNull(),
  inboxItemId: uuid("inbox_item_id")
    .notNull()
    .references(() => inboxEventItems.id),
  createdAt,
});

export const consentPolicies = pgTable(
  "consent_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    purpose: consentPurpose("purpose").notNull(),
    channel: contactKind("channel").notNull(),
    locale: text("locale").notNull(),
    version: integer("version").notNull(),
    noticeText: text("notice_text").notNull(),
    noticeHash: text("notice_hash").notNull(),
    scope: consentScope("scope").default("PROJECT_DISCOVERY").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    unique("consent_policies_identity_unique").on(
      t.organizationId,
      t.id,
      t.purpose,
      t.version,
      t.noticeHash,
      t.channel,
      t.locale,
      t.scope,
    ),
    unique("consent_policies_version_unique").on(
      t.organizationId,
      t.purpose,
      t.channel,
      t.locale,
      t.version,
    ),
    index("consent_policies_effective_idx").on(
      t.organizationId,
      t.purpose,
      t.channel,
      t.locale,
      t.effectiveAt,
    ),
    check("consent_policies_whatsapp_only", sql`${t.channel} = 'WHATSAPP'`),
    check("consent_policies_version_positive", sql`${t.version} > 0`),
  ],
);

export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    personId: uuid("person_id").notNull(),
    contactPointId: uuid("contact_point_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    purpose: consentPurpose("purpose").notNull(),
    action: consentAction("action").notNull(),
    sourceMessageId: uuid("source_message_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    noticeHash: text("notice_hash").notNull(),
    channel: contactKind("channel").notNull(),
    locale: text("locale").notNull(),
    scope: consentScope("scope").default("PROJECT_DISCOVERY").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "consent_records_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.personId],
      foreignColumns: [people.organizationId, people.id],
      name: "consent_records_person_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.personId, t.contactPointId],
      foreignColumns: [contactPoints.organizationId, contactPoints.personId, contactPoints.id],
      name: "consent_records_contact_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        t.organizationId,
        t.policyId,
        t.purpose,
        t.policyVersion,
        t.noticeHash,
        t.channel,
        t.locale,
        t.scope,
      ],
      foreignColumns: [
        consentPolicies.organizationId,
        consentPolicies.id,
        consentPolicies.purpose,
        consentPolicies.version,
        consentPolicies.noticeHash,
        consentPolicies.channel,
        consentPolicies.locale,
        consentPolicies.scope,
      ],
      name: "consent_records_policy_exact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.caseId, t.sourceMessageId],
      foreignColumns: [messages.organizationId, messages.caseId, messages.id],
      name: "consent_records_source_case_fk",
    }).onDelete("restrict"),
    unique("consent_records_idempotency_unique").on(t.organizationId, t.caseId, t.idempotencyKey),
    unique("consent_records_source_unique").on(t.organizationId, t.sourceMessageId, t.purpose),
    index("consent_records_current_idx").on(
      t.organizationId,
      t.caseId,
      t.personId,
      t.purpose,
      t.occurredAt,
    ),
    check("consent_records_whatsapp_only", sql`${t.channel} = 'WHATSAPP'`),
    check("consent_records_version_positive", sql`${t.policyVersion} > 0`),
  ],
);

export const consentRequests = pgTable(
  "consent_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    caseId: uuid("case_id").notNull(),
    personId: uuid("person_id").notNull(),
    contactPointId: uuid("contact_point_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    purpose: consentPurpose("purpose").notNull(),
    policyVersion: integer("policy_version").notNull(),
    noticeHash: text("notice_hash").notNull(),
    channel: contactKind("channel").notNull(),
    locale: text("locale").notNull(),
    scope: consentScope("scope").notNull(),
    sourceMessageId: uuid("source_message_id").notNull(),
    requestMessageId: uuid("request_message_id").notNull(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "restrict" }),
    status: consentRequestStatus("status").default("PENDING").notNull(),
    version,
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.caseId],
      foreignColumns: [prospectCases.organizationId, prospectCases.id],
      name: "consent_requests_case_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.personId, t.contactPointId],
      foreignColumns: [contactPoints.organizationId, contactPoints.personId, contactPoints.id],
      name: "consent_requests_contact_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        t.organizationId,
        t.policyId,
        t.purpose,
        t.policyVersion,
        t.noticeHash,
        t.channel,
        t.locale,
        t.scope,
      ],
      foreignColumns: [
        consentPolicies.organizationId,
        consentPolicies.id,
        consentPolicies.purpose,
        consentPolicies.version,
        consentPolicies.noticeHash,
        consentPolicies.channel,
        consentPolicies.locale,
        consentPolicies.scope,
      ],
      name: "consent_requests_policy_exact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.caseId, t.sourceMessageId],
      foreignColumns: [messages.organizationId, messages.caseId, messages.id],
      name: "consent_requests_source_case_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.caseId, t.requestMessageId],
      foreignColumns: [messages.organizationId, messages.caseId, messages.id],
      name: "consent_requests_message_case_fk",
    }).onDelete("restrict"),
    unique("consent_requests_logical_unique").on(
      t.organizationId,
      t.caseId,
      t.personId,
      t.policyId,
    ),
    unique("consent_requests_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    unique("consent_requests_outbox_unique").on(t.outboxEventId),
    unique("consent_requests_message_unique").on(t.requestMessageId),
    index("consent_requests_pending_idx").on(t.organizationId, t.status, t.expiresAt),
    check("consent_requests_whatsapp_only", sql`${t.channel} = 'WHATSAPP'`),
    check("consent_requests_version_positive", sql`${t.version} > 0`),
  ],
);
