/**
 * db.js – Shared database module for Jarvis agency automation platform.
 *
 * Supports two modes:
 *   1. PostgreSQL (when DATABASE_URL is set) – proper per-entity CRUD
 *   2. JSON file fallback (data/db.json)    – for local dev without Postgres
 *
 * Usage:
 *   const db = require('./db');
 *   await db.ensureSchema();
 *   const lead = await db.findRow('leads', 'some-uuid');
 *   const rows = await db.findRows('leads', { stage: 'NEW' }, 'created_at DESC', 50);
 *   const inserted = await db.insertRow('leads', { id: '...', business_name: '...' });
 *   await db.updateRow('leads', 'some-uuid', { stage: 'QUALIFIED' });
 *   await db.deleteRow('leads', 'some-uuid');
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
if (fs.existsSync(path.join(__dirname, '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

let DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  if (DATABASE_URL.startsWith('//')) {
    DATABASE_URL = 'postgresql:' + DATABASE_URL;
  } else if (!DATABASE_URL.includes('://')) {
    DATABASE_URL = 'postgresql://' + DATABASE_URL;
  }
}
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const isPostgres = Boolean(DATABASE_URL);

// ---------------------------------------------------------------------------
// PostgreSQL Pool
// ---------------------------------------------------------------------------
const pool = isPostgres
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('[db] PostgreSQL pool error:', err.message || err);
  });
}

// ---------------------------------------------------------------------------
// All entity types (used by JSON store initialisation)
// ---------------------------------------------------------------------------
const ENTITY_TYPES = [
  'users',
  'settings',
  'activity_logs',
  'leads',
  'contacts',
  'outreach_templates',
  'outreach_messages',
  'conversations',
  'follow_ups',
  'jobs',
  'job_executions',
  'requirements',
  'meetings',
  'client_briefs',
  'projects',
  'project_tasks',
  'demos',
  'feedback',
  'revisions',
  'quotations',
  'quotation_items',
  'deals',
  'approvals',
  'payments',
  'domain_hosting',
  'maintenance_plans',
  'notifications',
  'lead_stage_history',
  'scoring_results',
  'oauth_tokens',
  'ai_cache',
];

// ---------------------------------------------------------------------------
// Direct query helper (Postgres only)
// ---------------------------------------------------------------------------
async function query(text, params) {
  if (!pool) {
    throw new Error('[db] PostgreSQL is not configured. Set DATABASE_URL.');
  }
  return pool.query(text, params);
}

// ---------------------------------------------------------------------------
// Schema migration runner
// ---------------------------------------------------------------------------
async function ensureSchema() {
  if (!pool) return; // nothing to do for JSON mode

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 001_init.sql, 002_full_schema.sql, ...

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock migration execution using an arbitrary 64-bit integer
    await client.query('SELECT pg_advisory_xact_lock(987654321)');

    // Check if migrations table exists, if not create it
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get applied migrations
    const res = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(res.rows.map(r => r.version));

    for (const file of files) {
      if (!applied.has(file)) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        console.log(`[db] Migration applied: ${file}`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db] Migrations execution failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// JSON Store helpers
// ---------------------------------------------------------------------------
function _emptyStore() {
  const store = {};
  for (const entity of ENTITY_TYPES) {
    store[entity] = [];
  }
  return store;
}

function readStore() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const empty = _emptyStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Ensure every entity key exists
    for (const entity of ENTITY_TYPES) {
      if (!Array.isArray(raw[entity])) {
        raw[entity] = [];
      }
    }
    return raw;
  } catch (err) {
    console.error('[db] Failed to read JSON store, resetting:', err.message);
    const empty = _emptyStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// Allowed table names (whitelist for SQL injection prevention)
// ---------------------------------------------------------------------------
const ALLOWED_TABLES = new Set(ENTITY_TYPES);

function _assertTable(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`[db] Unknown table: ${table}`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Insert a single row.  `data` is a plain object whose keys are column names.
 * Returns the inserted row.
 */
async function _pgInsert(table, data) {
  _assertTable(table);
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error('[db] insertRow: no data provided');

  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => {
    const v = data[k];
    // Automatically JSON-stringify plain objects / arrays for JSONB columns
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      return JSON.stringify(v);
    }
    return v;
  });

  const sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`;
  const result = await pool.query(sql, values);
  return result.rows[0];
}

/**
 * Update a single row by id.  `data` is a plain object of columns to set.
 * Returns the updated row or null if not found.
 */
async function _pgUpdate(table, id, data) {
  _assertTable(table);
  const keys = Object.keys(data).filter((k) => k !== 'id');
  if (keys.length === 0) throw new Error('[db] updateRow: no data provided');

  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const values = keys.map((k) => {
    const v = data[k];
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      return JSON.stringify(v);
    }
    return v;
  });
  values.push(id);

  // Determine the primary key column.  The `settings` table uses `key` as PK.
  const pkCol = table === 'settings' ? 'key' : 'id';
  const sql = `UPDATE "${table}" SET ${setClauses} WHERE "${pkCol}" = $${values.length} RETURNING *`;
  const result = await pool.query(sql, values);
  return result.rows[0] || null;
}

/**
 * Delete a single row by id.  Returns true if a row was deleted.
 */
async function _pgDelete(table, id) {
  _assertTable(table);
  const pkCol = table === 'settings' ? 'key' : 'id';
  const sql = `DELETE FROM "${table}" WHERE "${pkCol}" = $1`;
  const result = await pool.query(sql, [id]);
  return result.rowCount > 0;
}

/**
 * Find a single row by id.  Returns the row or null.
 */
async function _pgFind(table, id) {
  _assertTable(table);
  const pkCol = table === 'settings' ? 'key' : 'id';
  const sql = `SELECT * FROM "${table}" WHERE "${pkCol}" = $1`;
  const result = await pool.query(sql, [id]);
  return result.rows[0] || null;
}

/**
 * Find rows with optional where, orderBy, limit, offset.
 *
 * `where` can be:
 *   - a plain object { column: value } (uses AND)
 *   - null / undefined (no filter)
 *
 * `orderBy` is a raw SQL fragment, e.g. 'created_at DESC'.
 */
async function _pgFindRows(table, where, orderBy, limit, offset) {
  _assertTable(table);
  let sql = `SELECT * FROM "${table}"`;
  const values = [];
  let idx = 1;

  if (where && typeof where === 'object' && Object.keys(where).length > 0) {
    const clauses = [];
    for (const [col, val] of Object.entries(where)) {
      clauses.push(`"${col}" = $${idx++}`);
      values.push(val);
    }
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  if (orderBy) {
    // Basic sanitisation – only allow alphanumerics, underscores, spaces, commas, ASC/DESC
    const safe = String(orderBy).replace(/[^a-zA-Z0-9_, ]/g, '');
    sql += ` ORDER BY ${safe}`;
  }

  if (limit != null) {
    sql += ` LIMIT $${idx++}`;
    values.push(Number(limit));
  }

  if (offset != null) {
    sql += ` OFFSET $${idx++}`;
    values.push(Number(offset));
  }

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * Count rows matching an optional where filter.
 */
async function _pgCount(table, where) {
  _assertTable(table);
  let sql = `SELECT COUNT(*)::int AS count FROM "${table}"`;
  const values = [];
  let idx = 1;

  if (where && typeof where === 'object' && Object.keys(where).length > 0) {
    const clauses = [];
    for (const [col, val] of Object.entries(where)) {
      clauses.push(`"${col}" = $${idx++}`);
      values.push(val);
    }
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  const result = await pool.query(sql, values);
  return result.rows[0].count;
}

// ---------------------------------------------------------------------------
// JSON file CRUD helpers
// ---------------------------------------------------------------------------

function _jsonInsert(table, data) {
  _assertTable(table);
  const store = readStore();
  store[table].push(data);
  writeStore(store);
  return data;
}

function _jsonUpdate(table, id, data) {
  _assertTable(table);
  const store = readStore();
  const pkField = table === 'settings' ? 'key' : 'id';
  const idx = store[table].findIndex((r) => r[pkField] === id);
  if (idx === -1) return null;
  store[table][idx] = { ...store[table][idx], ...data };
  writeStore(store);
  return store[table][idx];
}

function _jsonDelete(table, id) {
  _assertTable(table);
  const store = readStore();
  const pkField = table === 'settings' ? 'key' : 'id';
  const before = store[table].length;
  store[table] = store[table].filter((r) => r[pkField] !== id);
  writeStore(store);
  return store[table].length < before;
}

function _jsonFind(table, id) {
  _assertTable(table);
  const store = readStore();
  const pkField = table === 'settings' ? 'key' : 'id';
  return store[table].find((r) => r[pkField] === id) || null;
}

function _jsonFindRows(table, where, orderBy, limit, offset) {
  _assertTable(table);
  const store = readStore();
  let rows = [...store[table]];

  // Apply where filter
  if (where && typeof where === 'object') {
    for (const [col, val] of Object.entries(where)) {
      rows = rows.filter((r) => r[col] === val);
    }
  }

  // Apply orderBy (simple single-column support)
  if (orderBy) {
    const parts = String(orderBy).trim().split(/\s+/);
    const col = parts[0];
    const desc = (parts[1] || '').toUpperCase() === 'DESC';
    rows.sort((a, b) => {
      const va = a[col];
      const vb = b[col];
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
      return 0;
    });
  }

  // Apply offset and limit
  const start = offset ? Number(offset) : 0;
  if (limit != null) {
    rows = rows.slice(start, start + Number(limit));
  } else if (start > 0) {
    rows = rows.slice(start);
  }

  return rows;
}

function _jsonCount(table, where) {
  _assertTable(table);
  const store = readStore();
  let rows = store[table];
  if (where && typeof where === 'object') {
    for (const [col, val] of Object.entries(where)) {
      rows = rows.filter((r) => r[col] === val);
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Unified public API (delegates to Postgres or JSON)
// ---------------------------------------------------------------------------

async function insertRow(table, data) {
  return isPostgres ? _pgInsert(table, data) : _jsonInsert(table, data);
}

async function updateRow(table, id, data) {
  return isPostgres ? _pgUpdate(table, id, data) : _jsonUpdate(table, id, data);
}

async function deleteRow(table, id) {
  return isPostgres ? _pgDelete(table, id) : _jsonDelete(table, id);
}

async function findRow(table, id) {
  return isPostgres ? _pgFind(table, id) : _jsonFind(table, id);
}

async function findRows(table, where, orderBy, limit, offset) {
  return isPostgres
    ? _pgFindRows(table, where, orderBy, limit, offset)
    : _jsonFindRows(table, where, orderBy, limit, offset);
}

async function countRows(table, where) {
  return isPostgres ? _pgCount(table, where) : _jsonCount(table, where);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  pool,
  isPostgres,
  query,
  ensureSchema,

  // Per-entity CRUD
  insertRow,
  updateRow,
  deleteRow,
  findRow,
  findRows,
  countRows,

  // JSON fallback helpers (also usable in Postgres mode for compatibility)
  readStore,
  writeStore,

  // Utility
  ENTITY_TYPES,
  ALLOWED_TABLES,
};
