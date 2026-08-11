-- Supabase/PostgreSQL schema for Jarvis agency platform
-- This migration creates the tables needed to persist the existing application model.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  business_name TEXT,
  category TEXT,
  location TEXT,
  public_website TEXT,
  public_email TEXT,
  public_phone TEXT,
  whatsapp TEXT,
  instagram TEXT,
  other_contact TEXT,
  preferred_contact_method TEXT,
  contact_validity TEXT,
  last_contact_date TEXT,
  next_follow_up_date TEXT,
  opt_out BOOLEAN,
  source TEXT,
  discovery_date TIMESTAMPTZ,
  stage TEXT,
  score INTEGER,
  priority TEXT,
  qualification_reason TEXT,
  status TEXT,
  stage_history JSONB,
  website_analysis JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
