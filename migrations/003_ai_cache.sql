-- Migration 003: Create ai_cache table
CREATE TABLE IF NOT EXISTS ai_cache (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  response_data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_lead_id ON ai_cache(lead_id);
CREATE INDEX IF NOT EXISTS idx_ai_cache_lead_feature ON ai_cache(lead_id, feature);
