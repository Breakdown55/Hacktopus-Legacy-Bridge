-- What the project packages its modernized code for (packages/contracts/src/targets.ts). Existing projects are TypeScript.
ALTER TABLE projects ADD COLUMN target_language text NOT NULL DEFAULT 'typescript'
  CHECK (target_language IN ('typescript','python','go','java','csharp'));
