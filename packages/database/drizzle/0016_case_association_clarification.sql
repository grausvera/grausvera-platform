ALTER TABLE "inbox_event_items" ADD COLUMN "clarification_prompt" text;
ALTER TABLE "inbox_event_items" ADD CONSTRAINT "inbox_event_items_clarification_check" CHECK (
  ("status" = 'AMBIGUOUS' AND length("clarification_prompt") > 0)
  OR ("status" <> 'AMBIGUOUS' AND "clarification_prompt" IS NULL)
);
