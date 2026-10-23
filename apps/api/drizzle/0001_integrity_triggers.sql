-- Integrity rules the table definitions cannot express. Drizzle does not model
-- triggers, so they live in this hand-written migration. Each one enforces a
-- platform invariant in the database itself, whatever code path writes:
--   * evidence (events, artifacts, scores) is append-only, and nothing is added
--     to an attempt once it has finished;
--   * a finished attempt never changes;
--   * what an experiment tests is frozen: suite rows, tasks, task files, the
--     run matrix, frozen configuration versions and MCP definitions;
--   * an experiment's verdict history only grows;
--   * only the current owner of an attempt (its lease) can write to it;
--   * a score set is published whole, for the run's current attempt, and an
--     older evaluation can never replace a newer one;
--   * experiments carry a results revision that every relevant change bumps.
-- Violations raise SQLSTATE 23001 (restrict_violation).

CREATE FUNCTION hermes_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_immutable BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER scores_immutable BEFORE UPDATE OR DELETE ON scores
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER suites_immutable BEFORE UPDATE OR DELETE ON suites
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER tasks_immutable BEFORE UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER task_files_immutable BEFORE UPDATE OR DELETE ON task_files
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
-- Skills and documents never change; deleting an unused one stays possible.
CREATE TRIGGER skills_immutable BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint
-- A blob row stands for a file whose name is its hash; it never changes.
-- Deleting an unreferenced one stays possible; foreign keys protect the rest.
CREATE TRIGGER blobs_immutable BEFORE UPDATE ON blobs
  FOR EACH ROW EXECUTE FUNCTION hermes_reject_change();
--> statement-breakpoint

-- Events and artifacts may only be added while their attempt is running and owned.
-- FOR SHARE makes a concurrent finalise wait for this insert, so an attempt
-- cannot finish between the check and the insert.
CREATE FUNCTION hermes_require_open_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_finished_at timestamptz;
  attempt_revoked_at timestamptz;
BEGIN
  SELECT finished_at, lease_revoked_at INTO attempt_finished_at, attempt_revoked_at
    FROM attempts WHERE id = NEW.attempt_id FOR SHARE;
  IF attempt_finished_at IS NOT NULL OR attempt_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'attempt % has finished or lost its lease; no % may be added', NEW.attempt_id, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_require_open_attempt BEFORE INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION hermes_require_open_attempt();
--> statement-breakpoint
CREATE TRIGGER artifacts_require_open_attempt BEFORE INSERT ON artifacts
  FOR EACH ROW EXECUTE FUNCTION hermes_require_open_attempt();
--> statement-breakpoint

-- An attempt is written by its worker until it finishes, then never again.
-- Its identity, lease token, launch record and sandbox are fixed once set.
-- Once recovery revokes the lease, nothing the old owner produced may change:
-- the only allowed update ends the attempt as execution_error or cancelled.
CREATE FUNCTION hermes_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attempts cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'attempt % has finished and cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.trigger IS DISTINCT FROM OLD.trigger
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.trial_path IS DISTINCT FROM OLD.trial_path
     OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION 'attempt % identity cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.launch_record IS NOT NULL AND NEW.launch_record IS DISTINCT FROM OLD.launch_record THEN
    RAISE EXCEPTION 'attempt % launch record is written once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id)
     OR (OLD.sandbox_host_id IS NOT NULL AND NEW.sandbox_host_id IS DISTINCT FROM OLD.sandbox_host_id) THEN
    RAISE EXCEPTION 'attempt % sandbox is recorded once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.lease_revoked_at IS NOT NULL
     AND (NEW.status NOT IN ('execution_error', 'cancelled')
          OR (to_jsonb(NEW) - ARRAY['status', 'finished_at', 'error_category', 'error_message', 'exit_code', 'stderr_tail'])
             IS DISTINCT FROM
             (to_jsonb(OLD) - ARRAY['status', 'finished_at', 'error_category', 'error_message', 'exit_code', 'stderr_tail'])) THEN
    RAISE EXCEPTION 'attempt % lease was revoked; only recovery may end it', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempts_guard BEFORE UPDATE OR DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION hermes_attempts_guard();
--> statement-breakpoint

-- A run's place in the matrix is fixed; its status and counters move.
CREATE FUNCTION hermes_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runs cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.configuration_version_id IS DISTINCT FROM OLD.configuration_version_id
     OR NEW.repetition IS DISTINCT FROM OLD.repetition OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'run % position in the matrix cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_guard BEFORE UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION hermes_runs_guard();
--> statement-breakpoint

-- What an experiment tests is frozen at launch; only its lifecycle columns
-- move, its revisions only increase, and its verdict history only grows.
CREATE FUNCTION hermes_experiments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_length integer;
  kept_prefix jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'experiments cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.suite_id IS DISTINCT FROM OLD.suite_id
     OR NEW.task_ids IS DISTINCT FROM OLD.task_ids
     OR NEW.baseline_version_id IS DISTINCT FROM OLD.baseline_version_id
     OR NEW.candidate_version_ids IS DISTINCT FROM OLD.candidate_version_ids
     OR NEW.repetitions IS DISTINCT FROM OLD.repetitions
     OR NEW.hermes_version IS DISTINCT FROM OLD.hermes_version
     OR NEW.hermes_revision IS DISTINCT FROM OLD.hermes_revision
     OR NEW.time_budget_override_s IS DISTINCT FROM OLD.time_budget_override_s
     OR NEW.price_table IS DISTINCT FROM OLD.price_table OR NEW.estimate IS DISTINCT FROM OLD.estimate
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'experiment % was frozen at launch; what it tests cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.results_revision < OLD.results_revision
     OR (OLD.verdict_revision IS NOT NULL
         AND (NEW.verdict_revision IS NULL OR NEW.verdict_revision < OLD.verdict_revision)) THEN
    RAISE EXCEPTION 'experiment % revisions only move forward', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.verdict_history IS NOT DISTINCT FROM OLD.verdict_history THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.verdict_history) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'experiment % verdict history must be an array', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  old_length := jsonb_array_length(OLD.verdict_history);
  SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb) INTO kept_prefix
    FROM jsonb_array_elements(NEW.verdict_history) WITH ORDINALITY AS history(entry, position)
    WHERE position <= old_length;
  IF jsonb_array_length(NEW.verdict_history) < old_length OR kept_prefix IS DISTINCT FROM OLD.verdict_history THEN
    RAISE EXCEPTION 'experiment % verdict history is append-only', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER experiments_guard BEFORE UPDATE OR DELETE ON experiments
  FOR EACH ROW EXECUTE FUNCTION hermes_experiments_guard();
--> statement-breakpoint

-- A configuration version used by an experiment never changes again.
CREATE FUNCTION hermes_configuration_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'configuration version % is used by an experiment and cannot change; save a new version',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.configuration_id IS DISTINCT FROM OLD.configuration_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'configuration version % identity cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER configuration_versions_guard BEFORE UPDATE OR DELETE ON configuration_versions
  FOR EACH ROW EXECUTE FUNCTION hermes_configuration_versions_guard();
--> statement-breakpoint

-- A frozen MCP definition never changes; only its last test result may.
CREATE FUNCTION hermes_mcp_server_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'MCP server version % is used by a configuration and cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.mcp_server_id IS DISTINCT FROM OLD.mcp_server_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MCP server version % identity cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.frozen_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['last_test', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['last_test', 'updated_at']) THEN
    RAISE EXCEPTION 'MCP server version % is used by a configuration; edit it as a new version', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_server_versions_guard BEFORE UPDATE OR DELETE ON mcp_server_versions
  FOR EACH ROW EXECUTE FUNCTION hermes_mcp_server_versions_guard();
--> statement-breakpoint

-- A finished evaluation is fixed, except that it may be superseded once.
CREATE FUNCTION hermes_evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evaluations cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.cause IS DISTINCT FROM OLD.cause
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'evaluation % identity cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('completed', 'failed')
     AND (OLD.superseded_at IS NOT NULL
          OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at')) THEN
    RAISE EXCEPTION 'evaluation % has finished; it can only be superseded, once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evaluations_guard BEFORE UPDATE OR DELETE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION hermes_evaluations_guard();
--> statement-breakpoint

-- Scores are written by a running evaluation, all before it completes.
CREATE FUNCTION hermes_require_running_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evaluation_status text;
BEGIN
  SELECT status INTO evaluation_status FROM evaluations WHERE id = NEW.evaluation_id FOR SHARE;
  IF evaluation_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'evaluation % is %; scores can only be added while it is running',
      NEW.evaluation_id, coalesce(evaluation_status, 'missing') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scores_require_running_evaluation BEFORE INSERT ON scores
  FOR EACH ROW EXECUTE FUNCTION hermes_require_running_evaluation();
--> statement-breakpoint

-- An experiment launches only on frozen configuration versions, valid tasks of
-- its own suite row, and candidate ids that exist. Postgres cannot put foreign
-- keys on array elements, so the arrays are checked here. Launch freezes the
-- versions in an earlier statement; the freeze takes the row lock that orders
-- it against an in-place edit of the same version.
CREATE FUNCTION hermes_experiments_launch_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(array_append(NEW.candidate_version_ids, NEW.baseline_version_id)) AS v(id)
    WHERE v.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM configuration_versions cv WHERE cv.id = v.id AND cv.frozen_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'experiment % references a configuration version that does not exist or is not frozen', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.task_ids) AS t(id)
    WHERE t.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM tasks WHERE tasks.id = t.id AND tasks.suite_id = NEW.suite_id AND tasks.valid)
  ) THEN
    RAISE EXCEPTION 'experiment % selects a task that is missing, invalid or from another suite row', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER experiments_launch_check BEFORE INSERT ON experiments
  FOR EACH ROW EXECUTE FUNCTION hermes_experiments_launch_check();
--> statement-breakpoint

-- A run's configuration version must be frozen and one of its experiment's.
CREATE FUNCTION hermes_runs_launch_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM experiments e
    JOIN configuration_versions cv ON cv.id = NEW.configuration_version_id
    WHERE e.id = NEW.experiment_id AND cv.frozen_at IS NOT NULL
      AND (cv.id = e.baseline_version_id OR cv.id = ANY(e.candidate_version_ids))
      AND NEW.task_id = ANY(e.task_ids)
      AND NEW.repetition <= e.repetitions
  ) THEN
    RAISE EXCEPTION 'run does not belong to the matrix of experiment %, or its configuration version is not frozen',
      NEW.experiment_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_launch_check BEFORE INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION hermes_runs_launch_check();
--> statement-breakpoint

-- Only an attempt that produced an answer can be graded.
CREATE FUNCTION hermes_evaluations_require_executed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_status text;
BEGIN
  SELECT status INTO attempt_status FROM attempts WHERE id = NEW.attempt_id;
  IF attempt_status IS DISTINCT FROM 'executed' THEN
    RAISE EXCEPTION 'attempt % is %; only an executed attempt can be evaluated',
      NEW.attempt_id, coalesce(attempt_status, 'missing') USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evaluations_require_executed BEFORE INSERT ON evaluations
  FOR EACH ROW EXECUTE FUNCTION hermes_evaluations_require_executed();
--> statement-breakpoint

-- A configuration version's resource ids must exist, it may use one version
-- of each MCP server, and every MCP definition it uses becomes frozen.
CREATE FUNCTION hermes_configuration_versions_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.skill_ids) AS r(id)
             WHERE r.id IS NULL OR NOT EXISTS (SELECT 1 FROM skills WHERE skills.id = r.id))
     OR EXISTS (SELECT 1 FROM unnest(NEW.document_ids) AS r(id)
             WHERE r.id IS NULL OR NOT EXISTS (SELECT 1 FROM documents WHERE documents.id = r.id))
     OR EXISTS (SELECT 1 FROM unnest(NEW.mcp_server_version_ids) AS r(id)
             WHERE r.id IS NULL OR NOT EXISTS (SELECT 1 FROM mcp_server_versions m WHERE m.id = r.id)) THEN
    RAISE EXCEPTION 'configuration version % references a skill, document or MCP definition that does not exist',
      NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT m.mcp_server_id)
      FROM mcp_server_versions m WHERE m.id = ANY(NEW.mcp_server_version_ids)) THEN
    RAISE EXCEPTION 'configuration version % uses two versions of the same MCP server', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  UPDATE mcp_server_versions SET frozen_at = now()
    WHERE id = ANY(NEW.mcp_server_version_ids) AND frozen_at IS NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER configuration_versions_refs BEFORE INSERT OR UPDATE OF skill_ids, document_ids, mcp_server_version_ids
  ON configuration_versions FOR EACH ROW EXECUTE FUNCTION hermes_configuration_versions_refs();
--> statement-breakpoint

-- A configuration's or MCP server's latest version must exist. Deferred, so a
-- new identity and its version 1 are inserted in either order in one transaction.
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_latest_version_fk
  FOREIGN KEY (id, latest_version) REFERENCES mcp_server_versions (mcp_server_id, version)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE configurations ADD CONSTRAINT configurations_latest_version_fk
  FOREIGN KEY (id, latest_version) REFERENCES configuration_versions (configuration_id, version)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- Publishing a score set. Scores are written while the evaluation runs; this
-- guards the step that makes them the run's result:
--   * only the run's current attempt can be published;
--   * the set must hold exactly the keys the task declares (no partial sets);
--   * an evaluation older than one already published can never complete;
--   * a run's first evaluation cannot fail outright: error scores are published
--     instead, so the run always reaches scored;
--   * an evaluation is superseded only by a newer generation.
CREATE FUNCTION hermes_evaluations_publish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_attempt text;
  expected_keys text[];
  actual_keys text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('queued', 'running') THEN
      RAISE EXCEPTION 'evaluation % must start queued or running', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    SELECT r.current_attempt_id,
           ARRAY(SELECT e ->> 'key' FROM jsonb_array_elements(t.verification) AS e ORDER BY 1)
      INTO current_attempt, expected_keys
      FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = NEW.run_id;
    IF NEW.attempt_id IS DISTINCT FROM current_attempt THEN
      RAISE EXCEPTION 'evaluation % grades attempt %, not the run''s current attempt %',
        NEW.id, NEW.attempt_id, current_attempt USING ERRCODE = 'restrict_violation';
    END IF;
    actual_keys := ARRAY(SELECT s.key FROM scores s WHERE s.evaluation_id = NEW.id ORDER BY 1);
    IF actual_keys IS DISTINCT FROM expected_keys THEN
      RAISE EXCEPTION 'evaluation % has scores for % but the task declares %', NEW.id, actual_keys, expected_keys
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM evaluations e WHERE e.run_id = NEW.run_id AND e.generation > NEW.generation
                 AND e.status = 'completed') THEN
      RAISE EXCEPTION 'evaluation % is older than one already published', NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.status = 'failed' AND OLD.status <> 'failed'
     AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.run_id = NEW.run_id AND e.status = 'completed'
                       AND e.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'evaluation % is the run''s first; publish error scores instead of failing', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.superseded_at IS NOT NULL AND OLD.superseded_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.run_id = NEW.run_id AND e.generation > NEW.generation
                       AND e.status IN ('running', 'completed')) THEN
    RAISE EXCEPTION 'evaluation % can only be superseded by a newer generation', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evaluations_publish_guard BEFORE INSERT OR UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION hermes_evaluations_publish_guard();
--> statement-breakpoint

-- results_revision: bumped by statement-level triggers so no code path can
-- forget it. A run status change, or a score set published or superseded,
-- invalidates every cached comparison of that experiment. Inserts do not bump.
-- Lock order: any transaction that changes run status locks the experiment row
-- first, because this trigger then updates it.
CREATE FUNCTION hermes_runs_bump_results_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE experiments e SET results_revision = e.results_revision + 1
   WHERE e.id IN (SELECT n.experiment_id FROM new_runs n JOIN old_runs o ON o.id = n.id
                   WHERE n.status IS DISTINCT FROM o.status);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_results_revision AFTER UPDATE ON runs
  REFERENCING OLD TABLE AS old_runs NEW TABLE AS new_runs
  FOR EACH STATEMENT EXECUTE FUNCTION hermes_runs_bump_results_revision();
--> statement-breakpoint
CREATE FUNCTION hermes_evaluations_bump_results_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE experiments e SET results_revision = e.results_revision + 1
   WHERE e.id IN (SELECT r.experiment_id FROM new_evaluations n
                    JOIN old_evaluations o ON o.id = n.id JOIN runs r ON r.id = n.run_id
                   WHERE (n.status = 'completed') IS DISTINCT FROM (o.status = 'completed')
                      OR n.superseded_at IS DISTINCT FROM o.superseded_at);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evaluations_results_revision AFTER UPDATE ON evaluations
  REFERENCING OLD TABLE AS old_evaluations NEW TABLE AS new_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION hermes_evaluations_bump_results_revision();
