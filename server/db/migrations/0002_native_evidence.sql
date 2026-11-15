-- Each finding is bound to the revision, artifact digest and run together.
ALTER TABLE analysis_runs ADD CONSTRAINT analysis_run_revision_unique UNIQUE (org_id, id, source_revision_id);
ALTER TABLE source_artifacts ADD CONSTRAINT source_artifact_provenance_unique UNIQUE (org_id, source_revision_id, path, blob_sha256);

CREATE TABLE findings (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, source_revision_id uuid NOT NULL, analysis_run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('function','string','xref','import','pseudocode')),
  stable_key text NOT NULL, name text, address text,
  authority text NOT NULL CHECK (authority IN ('observed_static','tool_inferred')),
  attributes jsonb NOT NULL, location jsonb NOT NULL,
  artifact_path text NOT NULL, artifact_sha256 text NOT NULL,
  provider_evidence_id text NOT NULL CHECK (provider_evidence_id ~ '^ev_[0-9a-f]{64}$'),
  content_blob_sha256 text,
  UNIQUE (analysis_run_id, stable_key),
  FOREIGN KEY (org_id, analysis_run_id, source_revision_id) REFERENCES analysis_runs(org_id, id, source_revision_id),
  FOREIGN KEY (org_id, source_revision_id, artifact_path, artifact_sha256) REFERENCES source_artifacts(org_id, source_revision_id, path, blob_sha256),
  FOREIGN KEY (org_id, content_blob_sha256) REFERENCES blobs(org_id, sha256)
);
CREATE INDEX findings_revision_idx ON findings(org_id, source_revision_id, analysis_run_id, kind, stable_key);
CREATE INDEX findings_revision_address ON findings(org_id, source_revision_id, address) WHERE kind='function';
CREATE INDEX native_runs_by_source ON analysis_runs(org_id, source_revision_id, kind, created_at DESC, id DESC) WHERE provider='rea-ghidra';
CREATE INDEX native_jobs_by_source ON jobs(org_id, subject_id, created_at DESC, id DESC) WHERE kind IN ('native_index','native_deep_function');

CREATE TRIGGER findings_immutable BEFORE UPDATE OR DELETE ON findings
FOR EACH ROW EXECUTE FUNCTION lb_reject_mutation();
