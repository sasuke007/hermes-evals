CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_sha256_ck" CHECK ("blobs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "blobs_size_ck" CHECK ("blobs"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suite_sources" (
	"path" text PRIMARY KEY NOT NULL,
	"name" text,
	"current_suite_id" text,
	"last_attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_outcome" text NOT NULL,
	"last_error" jsonb,
	"last_changes" jsonb,
	CONSTRAINT "suite_sources_last_outcome_ck" CHECK ("suite_sources"."last_outcome" in ('created', 'unchanged', 'reverted', 'error', 'missing')),
	CONSTRAINT "suite_sources_error_ck" CHECK (("suite_sources"."last_outcome" = 'error') = ("suite_sources"."last_error" is not null)),
	CONSTRAINT "suite_sources_current_ck" CHECK ("suite_sources"."last_outcome" not in ('created', 'unchanged', 'reverted') or "suite_sources"."current_suite_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "suites" (
	"id" text PRIMARY KEY NOT NULL,
	"source_path" text NOT NULL,
	"name" text NOT NULL,
	"version_label" text NOT NULL,
	"description" text,
	"content_hash" text NOT NULL,
	"check_hash" text NOT NULL,
	"task_count" integer NOT NULL,
	"valid_count" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suites_id_source_uq" UNIQUE("id","source_path"),
	CONSTRAINT "suites_content_hash_ck" CHECK ("suites"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "suites_check_hash_ck" CHECK ("suites"."check_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "suites_counts_ck" CHECK ("suites"."valid_count" >= 0 and "suites"."valid_count" <= "suites"."task_count")
);
--> statement-breakpoint
CREATE TABLE "task_files" (
	"task_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "task_files_pk" PRIMARY KEY("task_id","path"),
	CONSTRAINT "task_files_kind_ck" CHECK ("task_files"."kind" in ('fixture', 'verifier', 'rubric', 'expected')),
	CONSTRAINT "task_files_sha256_ck" CHECK ("task_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_files_size_ck" CHECK ("task_files"."size" >= 0),
	CONSTRAINT "task_files_path_ck" CHECK ("task_files"."path" <> '' and "task_files"."path" !~ '(^/|(^|/)\.\.(/|$))')
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"summary" text,
	"prompt" text,
	"limits" jsonb,
	"reference" jsonb,
	"verification" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"self_check" jsonb NOT NULL,
	"load_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid" boolean NOT NULL,
	"invalid_reason" text,
	"content_hash" text NOT NULL,
	CONSTRAINT "tasks_key_ck" CHECK ("tasks"."key" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
	CONSTRAINT "tasks_position_ck" CHECK ("tasks"."position" >= 0),
	CONSTRAINT "tasks_content_hash_ck" CHECK ("tasks"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tasks_invalid_reason_ck" CHECK ("tasks"."valid" = ("tasks"."invalid_reason" is null)),
	CONSTRAINT "tasks_valid_complete_ck" CHECK (not "tasks"."valid" or ("tasks"."summary" is not null and "tasks"."prompt" is not null and "tasks"."limits" is not null and "tasks"."reference" is not null))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_sha256_ck" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_size_ck" CHECK ("documents"."size" >= 0),
	CONSTRAINT "documents_filename_ck" CHECK ("documents"."filename" <> '' and "documents"."filename" !~ '[/\\]' and "documents"."filename" not in ('.', '..'))
);
--> statement-breakpoint
CREATE TABLE "mcp_server_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"mcp_server_id" text NOT NULL,
	"version" integer NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" text[] DEFAULT '{}'::text[] NOT NULL,
	"env_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"url" text,
	"header_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"include" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"timeout_s" integer DEFAULT 60 NOT NULL,
	"definition_hash" text NOT NULL,
	"last_test" jsonb DEFAULT '{"status":"untested"}'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_versions_version_ck" CHECK ("mcp_server_versions"."version" >= 1),
	CONSTRAINT "mcp_server_versions_transport_ck" CHECK ("mcp_server_versions"."transport" in ('stdio', 'http')),
	CONSTRAINT "mcp_server_versions_shape_ck" CHECK (("mcp_server_versions"."transport" = 'stdio' and "mcp_server_versions"."command" is not null and "mcp_server_versions"."command" <> '' and "mcp_server_versions"."url" is null and cardinality("mcp_server_versions"."header_names") = 0)
       or ("mcp_server_versions"."transport" = 'http' and "mcp_server_versions"."url" is not null and "mcp_server_versions"."command" is null and cardinality("mcp_server_versions"."args") = 0 and cardinality("mcp_server_versions"."env_names") = 0)),
	CONSTRAINT "mcp_server_versions_url_ck" CHECK ("mcp_server_versions"."url" is null or "mcp_server_versions"."url" ~ '^https?://[^/?#@]+([/?#]|$)'),
	CONSTRAINT "mcp_server_versions_timeout_ck" CHECK ("mcp_server_versions"."timeout_s" between 1 and 3600),
	CONSTRAINT "mcp_server_versions_hash_ck" CHECK ("mcp_server_versions"."definition_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mcp_server_versions_last_test_ck" CHECK ("mcp_server_versions"."last_test" ->> 'status' in ('untested', 'running', 'passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_ck" CHECK ("mcp_servers"."name" ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "mcp_servers_latest_version_ck" CHECK ("mcp_servers"."latest_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_ck" CHECK ("skills"."name" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "skills_content_hash_ck" CHECK ("skills"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skills_file_count_ck" CHECK ("skills"."file_count" >= 1),
	CONSTRAINT "skills_size_ck" CHECK ("skills"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "configuration_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"api_key_env" text,
	"toolsets" text[] DEFAULT '{}'::text[] NOT NULL,
	"memory_enabled" boolean DEFAULT false NOT NULL,
	"skill_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"document_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"mcp_server_version_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_turns" integer NOT NULL,
	"time_budget_s" integer NOT NULL,
	"config_hash" text NOT NULL,
	"change_note" text,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configuration_versions_version_ck" CHECK ("configuration_versions"."version" >= 1),
	CONSTRAINT "configuration_versions_provider_ck" CHECK ("configuration_versions"."provider" in ('nous', 'nous-api', 'openrouter', 'openai', 'anthropic', 'custom')),
	CONSTRAINT "configuration_versions_model_ck" CHECK ("configuration_versions"."model" <> ''),
	CONSTRAINT "configuration_versions_custom_base_url_ck" CHECK ("configuration_versions"."provider" <> 'custom' or "configuration_versions"."base_url" is not null),
	CONSTRAINT "configuration_versions_base_url_ck" CHECK ("configuration_versions"."base_url" is null or "configuration_versions"."base_url" ~ '^https?://[^/?#@]+([/?#]|$)'),
	CONSTRAINT "configuration_versions_api_key_env_ck" CHECK ("configuration_versions"."api_key_env" is null or "configuration_versions"."api_key_env" ~ '^[A-Z_][A-Z0-9_]*$'),
	CONSTRAINT "configuration_versions_max_turns_ck" CHECK ("configuration_versions"."max_turns" between 1 and 200),
	CONSTRAINT "configuration_versions_time_budget_ck" CHECK ("configuration_versions"."time_budget_s" between 30 and 3600),
	CONSTRAINT "configuration_versions_hash_ck" CHECK ("configuration_versions"."config_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configurations_name_ck" CHECK ("configurations"."name" ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "configurations_latest_version_ck" CHECK ("configurations"."latest_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"concurrency" integer NOT NULL,
	"in_flight" integer DEFAULT 0 NOT NULL,
	"hermes_version" text NOT NULL,
	"hermes_revision" text NOT NULL,
	"toolsets" text[] DEFAULT '{}'::text[] NOT NULL,
	"env_names" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "workers_concurrency_ck" CHECK ("workers"."concurrency" between 1 and 16),
	CONSTRAINT "workers_in_flight_ck" CHECK ("workers"."in_flight" >= 0),
	CONSTRAINT "workers_hermes_revision_ck" CHECK ("workers"."hermes_revision" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"number" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"error_category" text,
	"error_message" text,
	"final_text" text,
	"session_id" text,
	"tokens" jsonb,
	"duration_ms" integer,
	"cost_usd" numeric(12, 6),
	"trial_path" text NOT NULL,
	"launch_record" jsonb,
	"stderr_tail" text,
	"redactions" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"lease_expires_at" timestamp with time zone DEFAULT now() + interval '60 seconds' NOT NULL,
	"lease_revoked_at" timestamp with time zone,
	"sandbox_id" text,
	"sandbox_host_id" text,
	CONSTRAINT "attempts_run_number_uq" UNIQUE("run_id","number"),
	CONSTRAINT "attempts_id_run_uq" UNIQUE("id","run_id"),
	CONSTRAINT "attempts_status_ck" CHECK ("attempts"."status" in ('running', 'executed', 'execution_error', 'cancelled')),
	CONSTRAINT "attempts_trigger_ck" CHECK ("attempts"."trigger" in ('initial', 'auto_retry', 'user_retry', 'recovery', 'retry_failed')),
	CONSTRAINT "attempts_error_category_ck" CHECK ("attempts"."error_category" is null or "attempts"."error_category" in ('provider', 'timeout', 'setup', 'worker_lost', 'other')),
	CONSTRAINT "attempts_number_ck" CHECK ("attempts"."number" between 1 and 5),
	CONSTRAINT "attempts_initial_ck" CHECK (("attempts"."number" = 1) = ("attempts"."trigger" = 'initial')),
	CONSTRAINT "attempts_finished_ck" CHECK (("attempts"."status" = 'running') = ("attempts"."finished_at" is null)),
	CONSTRAINT "attempts_error_category_status_ck" CHECK (("attempts"."status" = 'execution_error') = ("attempts"."error_category" is not null)),
	CONSTRAINT "attempts_executed_text_ck" CHECK ("attempts"."status" <> 'executed' or "attempts"."final_text" is not null),
	CONSTRAINT "attempts_duration_ck" CHECK ("attempts"."duration_ms" is null or "attempts"."duration_ms" >= 0),
	CONSTRAINT "attempts_cost_ck" CHECK ("attempts"."cost_usd" is null or ("attempts"."cost_usd" >= 0 and "attempts"."cost_usd" <> 'NaN'::numeric)),
	CONSTRAINT "attempts_redactions_ck" CHECK ("attempts"."redactions" >= 0),
	CONSTRAINT "attempts_revoked_not_executed_ck" CHECK ("attempts"."lease_revoked_at" is null or "attempts"."status" <> 'executed'),
	CONSTRAINT "attempts_trial_path_ck" CHECK ("attempts"."trial_path" <> '' and "attempts"."trial_path" !~ '(^/|(^|/)\.\.(/|$))')
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'running' NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"suite_id" text NOT NULL,
	"task_ids" text[] NOT NULL,
	"baseline_version_id" text NOT NULL,
	"candidate_version_ids" text[] NOT NULL,
	"repetitions" integer NOT NULL,
	"concurrency" integer NOT NULL,
	"spend_ceiling_usd" numeric(10, 2),
	"time_budget_override_s" integer,
	"hermes_version" text NOT NULL,
	"hermes_revision" text NOT NULL,
	"price_table" jsonb NOT NULL,
	"estimate" jsonb,
	"consecutive_execution_errors" integer DEFAULT 0 NOT NULL,
	"failure" jsonb,
	"verdict_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results_revision" bigint DEFAULT 0 NOT NULL,
	"verdict_revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "experiments_status_ck" CHECK ("experiments"."status" in ('running', 'paused', 'completed', 'failed')),
	CONSTRAINT "experiments_pause_reason_ck" CHECK ("experiments"."pause_reason" is null or "experiments"."pause_reason" in ('user', 'spend_ceiling')),
	CONSTRAINT "experiments_paused_ck" CHECK (("experiments"."status" = 'paused') = ("experiments"."pause_reason" is not null)),
	CONSTRAINT "experiments_paused_at_ck" CHECK (("experiments"."pause_reason" is null) = ("experiments"."paused_at" is null)),
	CONSTRAINT "experiments_finished_ck" CHECK (("experiments"."status" in ('completed', 'failed')) = ("experiments"."finished_at" is not null)),
	CONSTRAINT "experiments_failure_ck" CHECK ("experiments"."status" <> 'failed' or "experiments"."failure" is not null),
	CONSTRAINT "experiments_cancelled_ck" CHECK ("experiments"."cancelled_at" is null or "experiments"."status" in ('running', 'completed')),
	CONSTRAINT "experiments_repetitions_ck" CHECK ("experiments"."repetitions" >= 1),
	CONSTRAINT "experiments_concurrency_ck" CHECK ("experiments"."concurrency" between 1 and 16),
	CONSTRAINT "experiments_spend_ceiling_ck" CHECK ("experiments"."spend_ceiling_usd" is null or ("experiments"."spend_ceiling_usd" > 0 and "experiments"."spend_ceiling_usd" <> 'NaN'::numeric)),
	CONSTRAINT "experiments_time_budget_ck" CHECK ("experiments"."time_budget_override_s" is null or "experiments"."time_budget_override_s" between 30 and 3600),
	CONSTRAINT "experiments_verdict_revision_ck" CHECK ("experiments"."verdict_revision" is null or "experiments"."verdict_revision" <= "experiments"."results_revision"),
	CONSTRAINT "experiments_verdict_history_ck" CHECK (jsonb_typeof("experiments"."verdict_history") = 'array'),
	CONSTRAINT "experiments_consecutive_errors_ck" CHECK ("experiments"."consecutive_execution_errors" >= 0),
	CONSTRAINT "experiments_tasks_ck" CHECK (cardinality("experiments"."task_ids") >= 1),
	CONSTRAINT "experiments_candidates_ck" CHECK (cardinality("experiments"."candidate_version_ids") >= 1),
	CONSTRAINT "experiments_baseline_not_candidate_ck" CHECK (not ("experiments"."baseline_version_id" = any("experiments"."candidate_version_ids"))),
	CONSTRAINT "experiments_hermes_revision_ck" CHECK ("experiments"."hermes_revision" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"task_id" text NOT NULL,
	"configuration_version_id" text NOT NULL,
	"repetition" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"current_attempt_id" text,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status_ck" CHECK ("runs"."status" in ('queued', 'running', 'executed', 'scoring', 'scored', 'execution_error', 'cancelled')),
	CONSTRAINT "runs_repetition_ck" CHECK ("runs"."repetition" >= 1),
	CONSTRAINT "runs_attempt_count_ck" CHECK ("runs"."attempt_count" between 0 and 5),
	CONSTRAINT "runs_attempt_pointer_ck" CHECK (("runs"."attempt_count" = 0) = ("runs"."current_attempt_id" is null)),
	CONSTRAINT "runs_attempt_present_ck" CHECK ("runs"."status" in ('queued', 'cancelled') or "runs"."current_attempt_id" is not null),
	CONSTRAINT "runs_finished_ck" CHECK (("runs"."status" in ('scored', 'execution_error', 'cancelled')) = ("runs"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"path" text NOT NULL,
	"origin" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"skipped_reason" text,
	CONSTRAINT "artifacts_origin_ck" CHECK ("artifacts"."origin" in ('fixture_unchanged', 'fixture_modified', 'document_unchanged', 'document_modified', 'agent')),
	CONSTRAINT "artifacts_skipped_reason_ck" CHECK ("artifacts"."skipped_reason" is null or "artifacts"."skipped_reason" in ('too_large')),
	CONSTRAINT "artifacts_content_ck" CHECK (("artifacts"."sha256" is null) = ("artifacts"."skipped_reason" is not null)),
	CONSTRAINT "artifacts_sha256_ck" CHECK ("artifacts"."sha256" is null or "artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifacts_size_ck" CHECK ("artifacts"."size" >= 0),
	CONSTRAINT "artifacts_path_ck" CHECK ("artifacts"."path" <> '' and "artifacts"."path" !~ '(^/|(^|/)\.\.(/|$))')
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"attempt_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "run_events_pk" PRIMARY KEY("attempt_id","seq"),
	CONSTRAINT "run_events_seq_ck" CHECK ("run_events"."seq" >= 1),
	CONSTRAINT "run_events_type_ck" CHECK ("run_events"."type" in ('system', 'text', 'tool_use', 'tool_result', 'result', 'platform')),
	CONSTRAINT "run_events_payload_type_ck" CHECK (("run_events"."payload" ->> 'type') is not distinct from "run_events"."type")
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"cause" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"answer" jsonb,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	CONSTRAINT "evaluations_cause_ck" CHECK ("evaluations"."cause" in ('initial', 'rescore')),
	CONSTRAINT "evaluations_generation_ck" CHECK ("evaluations"."generation" >= 1),
	CONSTRAINT "evaluations_claim_ck" CHECK ("evaluations"."status" <> 'running' or ("evaluations"."claim_token" is not null and "evaluations"."claim_expires_at" is not null)),
	CONSTRAINT "evaluations_status_ck" CHECK ("evaluations"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "evaluations_started_ck" CHECK (("evaluations"."status" = 'queued') = ("evaluations"."started_at" is null)),
	CONSTRAINT "evaluations_finished_ck" CHECK (("evaluations"."status" in ('completed', 'failed')) = ("evaluations"."finished_at" is not null)),
	CONSTRAINT "evaluations_failed_ck" CHECK ("evaluations"."status" <> 'failed' or "evaluations"."error" is not null),
	CONSTRAINT "evaluations_superseded_ck" CHECK ("evaluations"."superseded_at" is null or "evaluations"."status" = 'completed')
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"score" double precision,
	"comment" text NOT NULL,
	"expected" jsonb,
	"observed" jsonb,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scorer_version" integer NOT NULL,
	CONSTRAINT "scores_status_ck" CHECK ("scores"."status" in ('passed', 'failed', 'error', 'ungradable')),
	CONSTRAINT "scores_type_ck" CHECK ("scores"."type" in ('numeric_tolerance', 'json_match', 'exact_match', 'file_check', 'trajectory_match', 'verifier_script', 'llm_judge')),
	CONSTRAINT "scores_score_range_ck" CHECK ("scores"."score" is null or ("scores"."score" >= 0 and "scores"."score" <= 1)),
	CONSTRAINT "scores_score_status_ck" CHECK ("scores"."status" in ('passed', 'failed') or "scores"."score" is null),
	CONSTRAINT "scores_scorer_version_ck" CHECK ("scores"."scorer_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "suite_sources" ADD CONSTRAINT "suite_sources_current_suite_fk" FOREIGN KEY ("current_suite_id","path") REFERENCES "public"."suites"("id","source_path") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_suite_id_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_versions" ADD CONSTRAINT "mcp_server_versions_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_configuration_id_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."configurations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_suite_id_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_baseline_version_id_configuration_versions_id_fk" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_configuration_version_id_configuration_versions_id_fk" FOREIGN KEY ("configuration_version_id") REFERENCES "public"."configuration_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_current_attempt_fk" FOREIGN KEY ("current_attempt_id","id") REFERENCES "public"."attempts"("id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_attempt_fk" FOREIGN KEY ("attempt_id","run_id") REFERENCES "public"."attempts"("id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suite_sources_name_uq" ON "suite_sources" USING btree ("name") WHERE name is not null and last_outcome <> 'missing';--> statement-breakpoint
CREATE UNIQUE INDEX "suites_source_hashes_uq" ON "suites" USING btree ("source_path","content_hash","check_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_suite_key_uq" ON "tasks" USING btree ("suite_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_suite_position_uq" ON "tasks" USING btree ("suite_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_versions_server_version_uq" ON "mcp_server_versions" USING btree ("mcp_server_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_name_uq" ON "mcp_servers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_version_uq" ON "skills" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_versions_config_version_uq" ON "configuration_versions" USING btree ("configuration_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "configurations_name_uq" ON "configurations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "workers_last_heartbeat_idx" ON "workers" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "attempts_lease_expiry_idx" ON "attempts" USING btree ("lease_expires_at") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_running_uq" ON "attempts" USING btree ("run_id") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_trial_path_uq" ON "attempts" USING btree ("trial_path");--> statement-breakpoint
CREATE INDEX "attempts_running_worker_idx" ON "attempts" USING btree ("worker_id") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "runs_matrix_uq" ON "runs" USING btree ("experiment_id","task_id","configuration_version_id","repetition");--> statement-breakpoint
CREATE INDEX "runs_experiment_status_idx" ON "runs" USING btree ("experiment_id","status");--> statement-breakpoint
CREATE INDEX "runs_configuration_version_idx" ON "runs" USING btree ("configuration_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_attempt_path_uq" ON "artifacts" USING btree ("attempt_id","path");--> statement-breakpoint
CREATE INDEX "evaluations_run_requested_idx" ON "evaluations" USING btree ("run_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_run_generation_uq" ON "evaluations" USING btree ("run_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_in_flight_uq" ON "evaluations" USING btree ("run_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_current_uq" ON "evaluations" USING btree ("run_id") WHERE status = 'completed' and superseded_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "scores_evaluation_key_uq" ON "scores" USING btree ("evaluation_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_evaluation_primary_uq" ON "scores" USING btree ("evaluation_id") WHERE is_primary;