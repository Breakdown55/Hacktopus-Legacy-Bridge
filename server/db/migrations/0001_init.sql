-- Legacy Bridge S1 schema (plan §3). Primary keys are app-generated UUIDv7.
-- Every tenant table carries org_id; children reference parents with composite (org_id, id) FKs.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL,
  execution_enabled boolean NOT NULL DEFAULT false,
  external_model_allowed boolean NOT NULL DEFAULT false,
  retention_days int NOT NULL DEFAULT 365, quota jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, display_name text,
  idp_subject text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, description text NOT NULL DEFAULT '', objectives text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  -- mutable head pointers; targets are immutable. Moved only by CAS on heads_version.
  current_source_revision_id uuid, approved_scope_revision_id uuid, current_module_revision_id uuid,
  current_case_set_revision_id uuid, current_policy_id uuid,
  heads_version int NOT NULL DEFAULT 0,
  UNIQUE (org_id, id)
);

CREATE TABLE blobs (
  org_id uuid NOT NULL REFERENCES organizations(id), sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL, media_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), purge_after timestamptz,
  PRIMARY KEY (org_id, sha256)
);
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, filename text NOT NULL,
  declared_size bigint NOT NULL, declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','rejected','expired','consumed')),
  staging_key text NOT NULL, expires_at timestamptz NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE TABLE source_revisions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, number int NOT NULL, parent_id uuid,
  notes text NOT NULL DEFAULT '', objectives text NOT NULL DEFAULT '', manifest_sha256 text NOT NULL,
  execution_consent_by uuid, execution_consent_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, number), FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE TABLE source_artifacts (
  source_revision_id uuid NOT NULL, org_id uuid NOT NULL, path text NOT NULL,
  role text NOT NULL CHECK (role IN ('primary_executable','shared_library','data_file','documentation','media','other')),
  blob_sha256 text NOT NULL, size_bytes bigint NOT NULL,
  PRIMARY KEY (source_revision_id, path),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_revisions(org_id, id),
  FOREIGN KEY (org_id, blob_sha256) REFERENCES blobs(org_id, sha256)
);
CREATE UNIQUE INDEX source_artifacts_one_primary ON source_artifacts (source_revision_id) WHERE role = 'primary_executable';

CREATE TABLE analysis_runs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, source_revision_id uuid NOT NULL, job_id uuid,
  kind text NOT NULL CHECK (kind IN ('inspect','index','deep_function','probe')),
  provider text NOT NULL, provider_version jsonb NOT NULL DEFAULT '{}', params jsonb NOT NULL DEFAULT '{}', params_digest text NOT NULL,
  outcome text CHECK (outcome IN ('complete','partial','unsupported','failed')),
  eligibility jsonb, coverage jsonb, limitations jsonb, unknowns jsonb, facts jsonb, raw_evidence_blob_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (org_id, id), FOREIGN KEY (org_id, source_revision_id) REFERENCES source_revisions(org_id, id)
);

CREATE TABLE scope_drafts (
  project_id uuid PRIMARY KEY, org_id uuid NOT NULL, base_revision_id uuid, document jsonb NOT NULL,
  version int NOT NULL DEFAULT 1, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE TABLE scope_revisions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, number int NOT NULL, parent_id uuid,
  source_revision_id uuid NOT NULL, document jsonb NOT NULL, document_sha256 text NOT NULL, schema_version int NOT NULL DEFAULT 1,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, number),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_revisions(org_id, id)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, scope_revision_id uuid NOT NULL, document_sha256 text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')), decided_by uuid, comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_revision_id), FOREIGN KEY (org_id, scope_revision_id) REFERENCES scope_revisions(org_id, id)
);

CREATE TABLE module_revisions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, number int NOT NULL, parent_id uuid,
  scope_revision_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('generated','user_edit','customer_upload')),
  target text NOT NULL DEFAULT 'typescript-node22',
  source_tree_blob_sha256 text NOT NULL, tree_sha256 text NOT NULL, file_manifest jsonb NOT NULL,
  public_interface jsonb, dependency_manifest jsonb, untranslated jsonb NOT NULL DEFAULT '[]', generator jsonb,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, number),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  FOREIGN KEY (org_id, scope_revision_id) REFERENCES scope_revisions(org_id, id)
);
CREATE TABLE execution_environments (
  id uuid PRIMARY KEY, name text NOT NULL, version int NOT NULL,
  role text NOT NULL CHECK (role IN ('original','replacement','build','analysis')),
  image_digest text NOT NULL, arch text NOT NULL, controls jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (name, version)
);
CREATE TABLE build_results (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, module_revision_id uuid NOT NULL, attempt int NOT NULL,
  build_image_digest text NOT NULL, toolchain jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('succeeded','failed','error')),
  diagnostics jsonb NOT NULL DEFAULT '[]', log_blob_sha256 text, output_blob_sha256 text,
  started_at timestamptz, finished_at timestamptz,
  UNIQUE (org_id, id), UNIQUE (module_revision_id, build_image_digest, attempt),
  FOREIGN KEY (org_id, module_revision_id) REFERENCES module_revisions(org_id, id)
);

CREATE TABLE test_cases (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL,
  input jsonb NOT NULL, input_digest text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('user','template','imported')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, input_digest),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
-- Only captured_original and user_supplied references can exist (invariant 6).
CREATE TABLE reference_outputs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, test_case_id uuid NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('captured_original','user_supplied')),
  source_revision_id uuid, execution_env_id uuid, capture_job_id uuid,
  observation jsonb NOT NULL, repeat_count int NOT NULL DEFAULT 1, deterministic boolean, variance jsonb,
  attestation text, supplied_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), FOREIGN KEY (org_id, test_case_id) REFERENCES test_cases(org_id, id),
  CONSTRAINT captured_needs_source CHECK (provenance <> 'captured_original' OR (source_revision_id IS NOT NULL AND execution_env_id IS NOT NULL AND capture_job_id IS NOT NULL AND deterministic IS NOT NULL)),
  CONSTRAINT supplied_needs_attestation CHECK (provenance <> 'user_supplied' OR (attestation IS NOT NULL AND length(attestation) > 0 AND supplied_by IS NOT NULL))
);
CREATE TABLE case_set_revisions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, number int NOT NULL, parent_id uuid,
  entries jsonb NOT NULL, digest text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, number), FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE TABLE comparison_policies (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, number int NOT NULL, parent_id uuid,
  rules jsonb NOT NULL, digest text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id), UNIQUE (project_id, number), FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE TABLE verification_runs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, job_id uuid,
  source_revision_id uuid NOT NULL, scope_revision_id uuid NOT NULL, module_revision_id uuid NOT NULL, build_result_id uuid NOT NULL,
  case_set_revision_id uuid NOT NULL, comparison_policy_id uuid NOT NULL, replacement_env_id uuid NOT NULL,
  binding jsonb NOT NULL, binding_digest text NOT NULL,
  completeness text CHECK (completeness IN ('complete','partial')), summary jsonb,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (org_id, id), FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE UNIQUE INDEX verification_runs_complete_binding ON verification_runs (org_id, binding_digest) WHERE completeness = 'complete';
CREATE TABLE verification_results (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, verification_run_id uuid NOT NULL, test_case_id uuid NOT NULL, reference_output_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('match','difference','couldnt_run','needs_reference')),
  actual jsonb, raw_equal boolean, normalized boolean NOT NULL DEFAULT false, normalization_trace jsonb NOT NULL DEFAULT '[]',
  differences jsonb NOT NULL DEFAULT '[]', diagnostics jsonb, log_blob_sha256 text, duration_ms int,
  UNIQUE (verification_run_id, test_case_id), FOREIGN KEY (org_id, verification_run_id) REFERENCES verification_runs(org_id, id),
  CONSTRAINT match_needs_reference CHECK (outcome <> 'match' OR reference_output_id IS NOT NULL)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid, kind text NOT NULL, subject_type text, subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}', dedupe_key text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempt int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3, run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text, lease_expires_at timestamptz, heartbeat_at timestamptz, cancel_requested_at timestamptz,
  progress jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  CHECK (status <> 'running' OR lease_owner IS NOT NULL)
);
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX jobs_claim ON jobs (run_after) WHERE status = 'queued';

CREATE TABLE export_packages (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, verification_run_id uuid NOT NULL, binding_digest text NOT NULL,
  manifest jsonb, manifest_sha256 text, sums_sha256 text, package_blob_sha256 text, job_id uuid,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
  UNIQUE (org_id, id), FOREIGN KEY (org_id, verification_run_id) REFERENCES verification_runs(org_id, id)
);
CREATE TABLE idempotency_keys (
  org_id uuid NOT NULL, user_id uuid NOT NULL, key text NOT NULL, request_sha256 text NOT NULL,
  response_status int NOT NULL, response_body jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, key)
);
CREATE TABLE events (
  id bigserial PRIMARY KEY, org_id uuid NOT NULL, project_id uuid, actor_id uuid, type text NOT NULL,
  subject_type text, subject_id text, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_project_cursor ON events (project_id, id);

-- ---------- immutability (§3.10) ----------
-- Reject UPDATE/DELETE on immutable tables. The purge procedure runs as role lb_purge.
CREATE FUNCTION lb_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'lb_purge' THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'table % is immutable (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['source_artifacts','scope_revisions','module_revisions','test_cases','reference_outputs',
                           'case_set_revisions','comparison_policies','execution_environments','verification_results','approvals','events']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lb_reject_mutation()', t, t);
  END LOOP;
END $$;

-- source_revisions: only the set-once consent columns may change.
CREATE FUNCTION lb_source_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'lb_purge' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'source_revisions is immutable' USING ERRCODE = 'restrict_violation'; END IF;
  IF (to_jsonb(NEW) - 'execution_consent_by' - 'execution_consent_at') IS DISTINCT FROM (to_jsonb(OLD) - 'execution_consent_by' - 'execution_consent_at')
     OR (OLD.execution_consent_at IS NOT NULL AND NEW.execution_consent_at IS DISTINCT FROM OLD.execution_consent_at) THEN
    RAISE EXCEPTION 'source_revisions is immutable apart from set-once consent' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_revisions_guard BEFORE UPDATE OR DELETE ON source_revisions FOR EACH ROW EXECUTE FUNCTION lb_source_revision_guard();

-- set-once finalisation: analysis_runs and verification_runs may be finalised once (outcome/completeness NULL -> value).
CREATE FUNCTION lb_finalize_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := TG_ARGV[0];
BEGIN
  IF current_user = 'lb_purge' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END IF;
  IF to_jsonb(OLD) ->> col IS NOT NULL THEN
    RAISE EXCEPTION '% already finalized', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER analysis_runs_finalize BEFORE UPDATE OR DELETE ON analysis_runs FOR EACH ROW EXECUTE FUNCTION lb_finalize_once('outcome');
CREATE TRIGGER verification_runs_finalize BEFORE UPDATE OR DELETE ON verification_runs FOR EACH ROW EXECUTE FUNCTION lb_finalize_once('completeness');
