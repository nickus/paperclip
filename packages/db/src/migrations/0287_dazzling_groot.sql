ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "execution_workspace_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;
