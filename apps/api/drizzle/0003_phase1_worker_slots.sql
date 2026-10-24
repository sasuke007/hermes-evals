-- Worker trial slots (UI_FLOWS 5.2: "2 of 4"): how many slot networks each
-- worker has, from its own TRIAL_SLOTS. Nullable: rows written before workers
-- reported it have no value, and the System page shows none for them.
ALTER TABLE "workers" ADD COLUMN "slots" integer;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_slots_ck" CHECK ("workers"."slots" is null or "workers"."slots" between 1 and 64);