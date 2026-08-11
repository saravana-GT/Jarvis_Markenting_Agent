-- ============================================================================
-- Migration 002: Full Schema aligned with server.js and test requirements
-- Run AFTER 001_init.sql
-- ============================================================================

-- 1. CONTACTS
CREATE TABLE IF NOT EXISTS contacts (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  role            TEXT,
  email           TEXT,
  phone           TEXT,
  whatsapp        TEXT,
  linkedin        TEXT,
  is_primary      BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_id ON contacts(lead_id);

-- 2. OUTREACH TEMPLATES
CREATE TABLE IF NOT EXISTS outreach_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  category        TEXT,
  variables       JSONB DEFAULT '[]',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. OUTREACH MESSAGES
CREATE TABLE IF NOT EXISTS outreach_messages (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  template_id     TEXT REFERENCES outreach_templates(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  personalization JSONB DEFAULT '{}',
  status          TEXT NOT NULL,
  sent_at         TIMESTAMPTZ,
  error           TEXT,
  external_id     TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_lead_id ON outreach_messages(lead_id);

-- 4. CONVERSATIONS
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL,
  channel         TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  external_id     TEXT,
  thread_id       TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations(lead_id);

-- 5. FOLLOW-UPS
CREATE TABLE IF NOT EXISTS follow_ups (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  sequence_number INTEGER,
  status          TEXT NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  template_id     TEXT,
  message_body    TEXT,
  sent_at         TIMESTAMPTZ,
  result          TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_id ON follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status);

-- 6. JOBS (persistent scheduler)
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         JSONB DEFAULT '{}',
  status          TEXT NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  error           TEXT,
  unique_key      TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);

-- 7. JOB EXECUTIONS
CREATE TABLE IF NOT EXISTS job_executions (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  error           TEXT,
  output          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_executions_job_id ON job_executions(job_id);

-- 8. REQUIREMENTS
CREATE TABLE IF NOT EXISTS requirements (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT REFERENCES leads(id) ON DELETE CASCADE,
  business_details    TEXT,
  website_purpose     TEXT,
  pages               JSONB DEFAULT '[]',
  features            JSONB DEFAULT '[]',
  design_preferences  JSONB DEFAULT '{}',
  brand_colors        TEXT,
  logo_url            TEXT,
  content_notes       TEXT,
  images_notes        TEXT,
  budget              TEXT,
  deadline            TEXT,
  domain_preference   TEXT,
  hosting_preference  TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_requirements_lead_id ON requirements(lead_id);

-- 9. MEETINGS
CREATE TABLE IF NOT EXISTS meetings (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  location        TEXT,
  meeting_url     TEXT,
  escalation_reason TEXT,
  status          TEXT NOT NULL DEFAULT 'SCHEDULED',
  external_event_id TEXT,
  outcome         TEXT,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meetings_lead_id ON meetings(lead_id);
CREATE INDEX IF NOT EXISTS idx_meetings_scheduled_at ON meetings(scheduled_at);

-- 10. CLIENT BRIEFS
CREATE TABLE IF NOT EXISTS client_briefs (
  id                      TEXT PRIMARY KEY,
  lead_id                 TEXT REFERENCES leads(id) ON DELETE CASCADE,
  business_summary        TEXT,
  lead_source             TEXT,
  conversation_summary    TEXT,
  known_requirements      TEXT,
  budget                  TEXT,
  deadline                TEXT,
  clarification_questions JSONB DEFAULT '[]',
  meeting_objective       TEXT,
  suggested_next_action   TEXT,
  status                  TEXT NOT NULL DEFAULT 'GENERATED',
  metadata                JSONB DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_briefs_lead_id ON client_briefs(lead_id);

-- 11. PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  requirements_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  pages           JSONB DEFAULT '[]',
  features        JSONB DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'PLANNING',
  status_history  JSONB DEFAULT '[]',
  deadline        TIMESTAMPTZ,
  preview_url     TEXT,
  production_url  TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_lead_id ON projects(lead_id);

-- 12. PROJECT TASKS
CREATE TABLE IF NOT EXISTS project_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'TODO',
  priority        TEXT NOT NULL DEFAULT 'MEDIUM',
  assignee        TEXT,
  due_date        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);

-- 13. DEMOS
CREATE TABLE IF NOT EXISTS demos (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  demo_url        TEXT NOT NULL,
  description     TEXT,
  expires_at      TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demos_project_id ON demos(project_id);

-- 14. FEEDBACK
CREATE TABLE IF NOT EXISTS feedback (
  id              TEXT PRIMARY KEY,
  demo_id         TEXT REFERENCES demos(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  rating          INTEGER,
  comments        TEXT,
  items           JSONB DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'SUBMITTED',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_project_id ON feedback(project_id);

-- 15. REVISIONS
CREATE TABLE IF NOT EXISTS revisions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL DEFAULT 1,
  description     TEXT,
  requested_changes JSONB DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'REQUESTED',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revisions_project_id ON revisions(project_id);

-- 16. QUOTATIONS
CREATE TABLE IF NOT EXISTS quotations (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT REFERENCES leads(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  base_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_percentage NUMERIC(6,2) DEFAULT 0,
  discount_amount     NUMERIC(12,2) DEFAULT 0,
  final_price         NUMERIC(12,2) NOT NULL DEFAULT 0,
  advance_percentage  NUMERIC(6,2) DEFAULT 50,
  advance_amount      NUMERIC(12,2) DEFAULT 0,
  balance             NUMERIC(12,2) DEFAULT 0,
  validity_date       TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  notes               TEXT,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quotations_lead_id ON quotations(lead_id);

-- 17. QUOTATION ITEMS
CREATE TABLE IF NOT EXISTS quotation_items (
  id              TEXT PRIMARY KEY,
  quotation_id    TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        INTEGER DEFAULT 1,
  unit_price      NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_q_id ON quotation_items(quotation_id);

-- 18. DEALS
CREATE TABLE IF NOT EXISTS deals (
  id                  TEXT PRIMARY KEY,
  lead_id             TEXT REFERENCES leads(id) ON DELETE CASCADE,
  quotation_id        TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  offered_price       NUMERIC(12,2) NOT NULL DEFAULT 0,
  counteroffer        NUMERIC(12,2),
  final_price         NUMERIC(12,2),
  status              TEXT NOT NULL DEFAULT 'OPEN',
  notes               TEXT,
  probability         INTEGER DEFAULT 50,
  expected_close_date TIMESTAMPTZ,
  won_reason          TEXT,
  lost_reason         TEXT,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deals_lead_id ON deals(lead_id);

-- 19. APPROVALS
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ,
  decided_by      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  deal_id         TEXT REFERENCES deals(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  total           NUMERIC(12,2) NOT NULL,
  advance         NUMERIC(12,2) DEFAULT 0,
  balance         NUMERIC(12,2) DEFAULT 0,
  advance_date    TIMESTAMPTZ,
  balance_date    TIMESTAMPTZ,
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_project_id ON payments(project_id);

-- 21. DOMAIN & HOSTING
CREATE TABLE IF NOT EXISTS domain_hosting (
  id                          TEXT PRIMARY KEY,
  project_id                  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain_required             BOOLEAN DEFAULT true,
  domain_name                 TEXT,
  domain_owner                TEXT,
  domain_cost_responsibility  TEXT DEFAULT 'client',
  registrar                   TEXT,
  domain_purchase_status      TEXT DEFAULT 'NOT_STARTED',
  domain_expiry               TIMESTAMPTZ,
  hosting_provider            TEXT,
  hosting_plan                TEXT,
  deployment_url              TEXT,
  renewal_date                TIMESTAMPTZ,
  metadata                    JSONB DEFAULT '{}',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_hosting_project_id ON domain_hosting(project_id);

-- 22. MAINTENANCE PLANS
CREATE TABLE IF NOT EXISTS maintenance_plans (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  plan_name       TEXT NOT NULL,
  description     TEXT,
  monthly_cost    NUMERIC(12,2) DEFAULT 0,
  annual_cost     NUMERIC(12,2) DEFAULT 0,
  includes        JSONB DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  start_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  renewal_date    TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_project_id ON maintenance_plans(project_id);

-- 23. NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  message         TEXT,
  entity_type     TEXT,
  entity_id       TEXT,
  is_read         BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 24. LEAD STAGE HISTORY
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead_id ON lead_stage_history(lead_id);

-- 25. SCORING RESULTS
CREATE TABLE IF NOT EXISTS scoring_results (
  id                    TEXT PRIMARY KEY,
  lead_id               TEXT REFERENCES leads(id) ON DELETE CASCADE,
  score                 INTEGER NOT NULL,
  priority              TEXT NOT NULL,
  qualification_status  TEXT NOT NULL,
  rules_triggered       JSONB DEFAULT '[]',
  qualification_reason  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scoring_results_lead_id ON scoring_results(lead_id);

-- 26. OAUTH TOKENS
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  provider        TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  token_type      TEXT DEFAULT 'Bearer',
  expires_at      TIMESTAMPTZ,
  scope           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);

-- TRIGGER FOR UPDATED_AT
CREATE OR REPLACE FUNCTION jarvis_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'contacts','outreach_templates','outreach_messages','conversations',
      'follow_ups','jobs','job_executions','requirements','meetings',
      'client_briefs','projects','project_tasks','demos','feedback',
      'revisions','quotations','quotation_items','deals','approvals',
      'payments','domain_hosting','maintenance_plans','notifications',
      'scoring_results','oauth_tokens'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I; ' ||
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I ' ||
      'FOR EACH ROW EXECUTE FUNCTION jarvis_set_updated_at();',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END;
$$;
