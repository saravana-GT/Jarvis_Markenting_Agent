const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const dns = require('dns').promises;

if (fs.existsSync(path.join(__dirname, '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

const db = require('./db');
const aiService = require('./aiService');
const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================
// In-memory cache (loaded from db on startup and kept in sync)
// =========================================================================
let store = db.readStore();

async function reloadStore() {
  if (db.isPostgres) {
    try {
      const [users, settings, activityLogs, leads] = await Promise.all([
        db.findRows('users', null, 'created_at ASC'),
        db.findRows('settings'),
        db.findRows('activity_logs', null, 'created_at DESC'),
        db.findRows('leads', null, 'updated_at ASC')
      ]);
      store.users = users;
      store.settings = settings;
      store.activity_logs = activityLogs;
      store.leads = leads.map(row => ({
        ...row,
        stage_history: row.stage_history || [],
        website_analysis: row.website_analysis || null
      }));
    } catch (err) {
      console.error('[server] Postgres reload failed, using cached store:', err.message);
    }
  } else {
    const s = db.readStore();
    Object.assign(store, s);
  }
}

// =========================================================================
// Constants
// =========================================================================
const PIPELINE_STAGES = [
  'NEW', 'DISCOVERED', 'ANALYZED', 'QUALIFIED', 'CONTACT_READY',
  'CONTACTED', 'FOLLOW_UP', 'REPLIED', 'INTERESTED',
  'REQUIREMENT_COLLECTION', 'MEETING_REQUIRED', 'MEETING_SCHEDULED',
  'NEGOTIATION', 'WON', 'LOST', 'PROJECT_ACTIVE', 'DELIVERED', 'MAINTENANCE'
];

const DEFAULT_SCORING_RULES = {
  noWebsite: 30, missingContact: 25, publicContact: 20,
  categoryPriority: 10, locationPriority: 10, contactValid: 5
};

// =========================================================================
// Middleware
// =========================================================================
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set. Using insecure default. Set SESSION_SECRET in .env for production.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-dev-secret-' + require('crypto').randomBytes(16).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: true, maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// =========================================================================
// Helpers
// =========================================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentication required' });
}

async function logActivity(action, entityType, entityId, description) {
  const entry = {
    id: uuidv4(), action, entity_type: entityType,
    entity_id: entityId, description, created_at: new Date().toISOString()
  };
  await db.insertRow('activity_logs', entry);
  if (!store.activity_logs) store.activity_logs = [];
  store.activity_logs.unshift(entry);
}

function parseScoringRules() {
  const scoringSetting = (store.settings || []).find(item => item.key === 'lead_scoring_rules');
  if (!scoringSetting) return DEFAULT_SCORING_RULES;
  try { return { ...DEFAULT_SCORING_RULES, ...JSON.parse(scoringSetting.value) }; }
  catch { return DEFAULT_SCORING_RULES; }
}

function calculateLeadScore(lead) {
  const lowerName = (lead.business_name || '').toLowerCase();
  const lowerCategory = (lead.category || '').toLowerCase();
  const isCompetitor = lowerName.includes('web design') || lowerName.includes('website design') || 
                       lowerName.includes('seo') || lowerName.includes('marketing agency') || 
                       lowerName.includes('digital marketing') || lowerName.includes('software development') ||
                       lowerCategory.includes('web_designer') || lowerCategory.includes('marketing_agency') ||
                       lowerCategory.includes('seo') || lowerCategory.includes('consultant');
  
  if (isCompetitor) {
    return { score: 0, rulesTriggered: [{ rule: 'competitorFilter', points: -100 }] };
  }

  const rules = parseScoringRules();
  let score = 0;
  const rulesTriggered = [];
  const hasWebsite = Boolean(lead.public_website && lead.public_website.trim());
  const hasEmail = Boolean(lead.public_email && lead.public_email.trim());
  const hasPhone = Boolean(lead.public_phone && lead.public_phone.trim());
  const hasContact = hasEmail || hasPhone || Boolean(lead.whatsapp || lead.instagram || lead.other_contact);

  if (!hasWebsite) { 
    score += 55; // High priority boost if they don't even have a website!
    rulesTriggered.push({ rule: 'noWebsite', points: 55 }); 
  }
  if (!hasContact) { score += Number(rules.missingContact || 0); rulesTriggered.push({ rule: 'missingContact', points: rules.missingContact }); }
  if (hasContact) { score += Number(rules.publicContact || 0); rulesTriggered.push({ rule: 'publicContact', points: rules.publicContact }); }
  if (lead.contact_validity === 'VALID') { score += Number(rules.contactValid || 0); rulesTriggered.push({ rule: 'contactValid', points: rules.contactValid }); }
  if (lead.category && lead.category.toLowerCase().includes('restaurant')) { score += Number(rules.categoryPriority || 0); rulesTriggered.push({ rule: 'categoryPriority', points: rules.categoryPriority }); }
  if (lead.location && lead.location.toLowerCase().includes('local')) { score += Number(rules.locationPriority || 0); rulesTriggered.push({ rule: 'locationPriority', points: rules.locationPriority }); }
  
  // Website audit-based scoring
  if (lead.website_analysis) {
    const analysis = typeof lead.website_analysis === 'string' ? JSON.parse(lead.website_analysis) : lead.website_analysis;
    if (analysis) {
      if (analysis.https_available === false) { score += 25; rulesTriggered.push({ rule: 'noHttps', points: 25 }); }
      if (analysis.mobile_friendly === false) { score += 25; rulesTriggered.push({ rule: 'notMobileFriendly', points: 25 }); }
      if (analysis.whatsapp_present === false) { score += 20; rulesTriggered.push({ rule: 'noWhatsApp', points: 20 }); }
      if (analysis.contact_page === false) { score += 15; rulesTriggered.push({ rule: 'noContactPage', points: 15 }); }
    }
  }

  const finalScore = Math.min(100, Math.max(0, Math.round(score)));
  return { score: finalScore, rulesTriggered };
}

function calculatePriority(score) {
  if (score >= 80) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

function normalizeValue(value) { return String(value || '').trim().toLowerCase(); }

function isDuplicateLead(newLead, excludeId) {
  const website = normalizeValue(newLead.public_website);
  const email = normalizeValue(newLead.public_email);
  const phone = normalizeValue(newLead.public_phone);
  const name = normalizeValue(newLead.business_name);
  const location = normalizeValue(newLead.location);
  return (store.leads || []).some(lead => {
    if (excludeId && lead.id === excludeId) return false;
    const en = normalizeValue(lead.business_name);
    const ee = normalizeValue(lead.public_email);
    const ep = normalizeValue(lead.public_phone);
    const ew = normalizeValue(lead.public_website);
    const el = normalizeValue(lead.location);
    if (email && ee === email) return true;
    if (website && ew === website) return true;
    if (phone && ep === phone) return true;
    if (name && en === name && (!location || !el || el === location)) return true;
    return false;
  });
}


function buildQualificationReason(lead) {
  if (!lead.public_website) return 'No website available';
  if (!lead.website_analysis) return 'Website analysis not completed';
  if (!lead.website_analysis.accessible) return 'Website is inaccessible';
  if (!lead.website_analysis.contact_present) return 'Contact details missing from site';
  return 'Lead has a website and valid contact details';
}

function getSetting(key, defaultValue) {
  const s = (store.settings || []).find(item => item.key === key);
  return s ? s.value : defaultValue;
}

// =========================================================================
// Startup — seed defaults
// =========================================================================
async function ensureDefaults() {
  await reloadStore();
  if (!store.users) store.users = [];
  if (!store.activity_logs) store.activity_logs = [];
  if (!store.settings) store.settings = [];
  if (!store.leads) store.leads = [];

  const defaults = [
    ['daily_contact_limit', '10'], ['follow_up_interval_days', '3'],
    ['max_follow_ups', '4'], ['minimum_acceptable_price', '500'],
    ['default_advance_percentage', '50'], ['target_industries', 'Web Design, Development, SEO'],
    ['target_locations', 'Local'], ['working_hours', '09:00-17:00'],
    ['meeting_availability', 'Monday-Friday'], ['service_packages', 'Starter, Growth, Premium'],
    ['notification_preferences', 'new_reply,follow_up_due,approval_required,payment_due'],
    ['lead_scoring_rules', JSON.stringify(DEFAULT_SCORING_RULES)]
  ];

  const existingKeys = new Set(store.settings.map(item => item.key));
  for (const [key, value] of defaults) {
    if (!existingKeys.has(key)) {
      await db.insertRow('settings', { key, value });
      store.settings.push({ key, value });
    }
  }

  if (!store.users.some(user => user.username === 'owner')) {
    const passwordHash = bcrypt.hashSync('admin1234', 10);
    const user = { id: uuidv4(), username: 'owner', password_hash: passwordHash, full_name: 'Agency Owner', role: 'owner', created_at: new Date().toISOString() };
    await db.insertRow('users', user);
    store.users.push(user);
  }
}

function getDashboardStats() {
  const leads = store.leads || [];
  const logs = store.activity_logs || [];
  return {
    totalLeads: leads.length,
    newLeads: leads.filter(l => l.stage === 'NEW').length,
    qualifiedLeads: leads.filter(l => ['QUALIFIED','CONTACT_READY','CONTACTED','FOLLOW_UP','REPLIED','INTERESTED'].includes(l.stage)).length,
    contactedLeads: leads.filter(l => ['CONTACTED','FOLLOW_UP','REPLIED','INTERESTED','REQUIREMENT_COLLECTION','MEETING_REQUIRED','MEETING_SCHEDULED','NEGOTIATION','WON','PROJECT_ACTIVE','DELIVERED','MAINTENANCE'].includes(l.stage)).length,
    replies: logs.filter(i => i.action === 'Reply received').length,
    interestedClients: leads.filter(l => ['INTERESTED','REQUIREMENT_COLLECTION','MEETING_REQUIRED','MEETING_SCHEDULED','NEGOTIATION','WON','PROJECT_ACTIVE','DELIVERED','MAINTENANCE'].includes(l.stage)).length,
    meetings: logs.filter(i => i.action === 'Meeting created').length,
    activeNegotiations: leads.filter(l => l.stage === 'NEGOTIATION').length,
    wonDeals: leads.filter(l => l.stage === 'WON').length,
    lostDeals: leads.filter(l => l.stage === 'LOST').length,
    activeProjects: leads.filter(l => l.stage === 'PROJECT_ACTIVE').length,
    completedProjects: leads.filter(l => l.stage === 'DELIVERED').length,
    pendingApprovals: logs.filter(i => i.action === 'Approval requested').length,
    pendingPayments: logs.filter(i => i.action === 'Payment updated').length,
    estimatedPipelineValue: 0,
    revenue: 0
  };
}

// =========================================================================
// AUTH ROUTES
// =========================================================================
app.get('/api/auth/me', requireAuth, async (req, res) => {
  await reloadStore();
  const user = store.users.find(item => item.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post('/api/auth/login', async (req, res) => {
  await reloadStore();
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = store.users.find(item => item.username === username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  await logActivity('User logged in', 'User', user.id, `${user.username} logged in`);
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// =========================================================================
// DASHBOARD & ACTIVITY
// =========================================================================
app.get('/api/dashboard', requireAuth, async (req, res) => {
  await reloadStore();
  const stats = getDashboardStats();
  // Augment with real data from new tables
  try {
    const deals = await db.findRows('deals', { status: 'WON' });
    const payments = await db.findRows('payments');
    const projects = await db.findRows('projects');
    stats.wonDeals = deals.length;
    stats.revenue = payments.filter(p => p.status === 'PAID').reduce((sum, p) => sum + Number(p.total || 0), 0);
    stats.estimatedPipelineValue = deals.reduce((sum, d) => sum + Number(d.final_price || d.offered_price || 0), 0);
    stats.activeProjects = projects.filter(p => !['DELIVERED','CANCELLED'].includes(p.status)).length;
    stats.completedProjects = projects.filter(p => p.status === 'DELIVERED').length;
  } catch (e) { /* tables may not exist yet */ }
  res.json(stats);
});

app.get('/api/activity', requireAuth, async (req, res) => {
  const rows = await db.findRows('activity_logs', null, 'created_at DESC', 50);
  res.json(rows);
});

// =========================================================================
// SETTINGS
// =========================================================================
app.get('/api/settings', requireAuth, async (req, res) => {
  const rows = await db.findRows('settings');
  const settings = Object.fromEntries(rows.map(item => [item.key, item.value]));
  res.json(settings);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    const existing = await db.findRow('settings', key);
    if (existing) {
      await db.updateRow('settings', key, { value: String(value) });
    } else {
      await db.insertRow('settings', { key, value: String(value) });
    }
  }
  await reloadStore();
  await logActivity('Settings updated', 'Settings', null, `Updated settings: ${Object.keys(updates).join(', ')}`);
  res.json({ success: true });
});

// =========================================================================
// LEAD STAGES
// =========================================================================
app.get('/api/lead-stages', requireAuth, (req, res) => {
  res.json(PIPELINE_STAGES);
});

// =========================================================================
// LEADS (Checkpoint 5 — Complete Lead Management)
// =========================================================================
app.get('/api/leads', requireAuth, async (req, res) => {
  await reloadStore();
  let leads = store.leads || [];
  const { search, stage, priority, source, offset = 0, limit = 50 } = req.query;
  if (stage) leads = leads.filter(l => l.stage === stage);
  if (priority) leads = leads.filter(l => l.priority === priority);
  if (source) leads = leads.filter(l => l.source === source);
  if (search) {
    const q = String(search).toLowerCase();
    leads = leads.filter(l =>
      (l.business_name || '').toLowerCase().includes(q) ||
      (l.category || '').toLowerCase().includes(q) ||
      (l.location || '').toLowerCase().includes(q) ||
      (l.public_email || '').toLowerCase().includes(q) ||
      (l.public_phone || '').toLowerCase().includes(q)
    );
  }
  const total = leads.length;
  const paged = leads.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ leads: paged, total });
});

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  const lead = await db.findRow('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.stage_history = lead.stage_history || [];
  lead.website_analysis = lead.website_analysis || null;
  res.json(lead);
});

app.get('/api/unsubscribe', async (req, res) => {
  const { lead_id } = req.query;
  if (!lead_id) return res.status(400).send('Lead ID is required.');
  
  const lead = await db.findRow('leads', lead_id);
  if (!lead) return res.status(404).send('Lead not found.');
  
  await db.updateRow('leads', lead_id, { opt_out: true, updated_at: new Date().toISOString() });
  await logActivity('Lead opted out', 'Lead', lead_id, `Lead ${lead.business_name} unsubscribed from outreach.`);
  
  res.send('<html><body><h2>You have been unsubscribed successfully.</h2><p>You will no longer receive emails from us.</p></body></html>');
});

app.post('/api/leads', requireAuth, async (req, res) => {
  await reloadStore();
  const { businessName, business_name, category, location, publicWebsite, public_website,
    publicEmail, public_email, publicPhone, public_phone, source, whatsapp, instagram,
    other_contact, preferred_contact_method } = req.body;
  
  const bName = businessName || business_name;
  const pWebsite = publicWebsite || public_website || '';
  const pEmail = publicEmail || public_email || '';
  const pPhone = publicPhone || public_phone || '';
  
  if (!bName) return res.status(400).json({ error: 'Business name is required' });
  
  const leadData = { business_name: bName, public_email: pEmail, public_phone: pPhone, public_website: pWebsite, location };
  if (isDuplicateLead(leadData)) {
    const existing = (store.leads || []).find(lead => {
      const en = normalizeValue(lead.business_name);
      const ee = normalizeValue(lead.public_email);
      const ep = normalizeValue(lead.public_phone);
      const ew = normalizeValue(lead.public_website);
      const el = normalizeValue(lead.location);
      
      const website = normalizeValue(pWebsite);
      const email = normalizeValue(pEmail);
      const phone = normalizeValue(pPhone);
      const name = normalizeValue(bName);
      const loc = normalizeValue(location);

      if (email && ee === email) return true;
      if (website && ew === website) return true;
      if (phone && ep === phone) return true;
      if (name && en === name && (!loc || !el || el === loc)) return true;
      return false;
    });
    return res.status(409).json({ error: 'Lead already exists or appears to be a duplicate', lead: existing });
  }


  const now = new Date().toISOString();
  const { score, rulesTriggered } = calculateLeadScore({
    public_website: pWebsite, public_email: pEmail, public_phone: pPhone,
    whatsapp: whatsapp || '', instagram: instagram || '', other_contact: other_contact || '',
    contact_validity: 'UNKNOWN', category, location
  });

  const lead = {
    id: uuidv4(), business_name: bName, category: category || '', location: location || '',
    public_website: pWebsite, public_email: pEmail, public_phone: pPhone,
    whatsapp: whatsapp || '', instagram: instagram || '', other_contact: other_contact || '',
    preferred_contact_method: preferred_contact_method || (pEmail ? 'Email' : pPhone ? 'Phone' : 'Unknown'),
    contact_validity: 'UNKNOWN', last_contact_date: '', next_follow_up_date: '',
    opt_out: false, source: source || '', discovery_date: now,
    stage: 'NEW', score, priority: calculatePriority(score),
    qualification_reason: 'Awaiting initial review', status: 'ACTIVE',
    stage_history: [{ stage: 'NEW', changed_at: now }],
    created_at: now, updated_at: now
  };

  await db.insertRow('leads', lead);
  store.leads.push(lead);

  // Save scoring result
  await db.insertRow('scoring_results', {
    id: uuidv4(), lead_id: lead.id, score, priority: lead.priority,
    qualification_status: 'PENDING', rules_triggered: rulesTriggered,
    qualification_reason: lead.qualification_reason, created_at: now
  });

  // Save stage history
  await db.insertRow('lead_stage_history', {
    id: uuidv4(), lead_id: lead.id, stage: 'NEW', changed_at: now, created_at: now
  });

  await logActivity('Lead created', 'Lead', lead.id, `Created lead for ${bName}`);
  res.json({ id: lead.id, success: true, lead });
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  await reloadStore();
  const lead = (store.leads || []).find(item => item.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const updates = req.body;
  const allowedFields = [
    'business_name', 'category', 'location', 'public_website', 'public_email', 'public_phone', 'source',
    'whatsapp', 'instagram', 'other_contact', 'preferred_contact_method', 'contact_validity',
    'last_contact_date', 'next_follow_up_date', 'opt_out', 'qualification_reason', 'stage'
  ];

  // Also accept camelCase field names from UI
  if (updates.publicEmail) updates.public_email = updates.publicEmail;
  if (updates.publicPhone) updates.public_phone = updates.publicPhone;
  if (updates.publicWebsite) updates.public_website = updates.publicWebsite;

  let stageChanged = false;
  const dbUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!allowedFields.includes(key)) continue;
    if (key === 'stage' && value && value !== lead.stage && PIPELINE_STAGES.includes(value)) {
      stageChanged = true;
      lead.stage = value;
      dbUpdates.stage = value;
      if (!lead.stage_history) lead.stage_history = [];
      lead.stage_history.unshift({ stage: value, changed_at: new Date().toISOString() });
      dbUpdates.stage_history = lead.stage_history;
      await db.insertRow('lead_stage_history', {
        id: uuidv4(), lead_id: lead.id, stage: value, changed_at: new Date().toISOString(), created_at: new Date().toISOString()
      });
      await logActivity('Stage changed', 'Lead', lead.id, `Lead stage changed to ${value}`);
    } else if (key !== 'stage') {
      lead[key] = value;
      dbUpdates[key] = value;
    }
  }

  const { score, rulesTriggered } = calculateLeadScore(lead);
  lead.score = score;
  lead.priority = calculatePriority(score);
  lead.updated_at = new Date().toISOString();
  dbUpdates.score = score;
  dbUpdates.priority = lead.priority;
  dbUpdates.updated_at = lead.updated_at;

  await db.updateRow('leads', lead.id, dbUpdates);
  if (!stageChanged) {
    await logActivity('Lead updated', 'Lead', lead.id, `Updated lead details for ${lead.business_name}`);
  }
  res.json({ success: true, lead });
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  await reloadStore();
  const index = (store.leads || []).findIndex(item => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Lead not found' });
  const lead = store.leads[index];
  const leadId = lead.id;
  
  await db.deleteRow('leads', leadId);
  store.leads.splice(index, 1);
  
  // Clean up associated records to prevent database orphans and duplicate checks
  if (db.isPostgres) {
    await db.query('DELETE FROM outreach_messages WHERE lead_id = $1', [leadId]);
    await db.query('DELETE FROM contacts WHERE lead_id = $1', [leadId]);
    await db.query('DELETE FROM conversations WHERE lead_id = $1', [leadId]);
    await db.query('DELETE FROM follow_ups WHERE lead_id = $1', [leadId]);
    await db.query('DELETE FROM lead_stage_history WHERE lead_id = $1', [leadId]);
    await db.query('DELETE FROM scoring_results WHERE lead_id = $1', [leadId]);
  } else {
    // JSON file fallback clean up
    const fallbackStore = db.readStore();
    fallbackStore.outreach_messages = (fallbackStore.outreach_messages || []).filter(m => m.lead_id !== leadId);
    fallbackStore.contacts = (fallbackStore.contacts || []).filter(c => c.lead_id !== leadId);
    fallbackStore.conversations = (fallbackStore.conversations || []).filter(c => c.lead_id !== leadId);
    fallbackStore.follow_ups = (fallbackStore.follow_ups || []).filter(f => f.lead_id !== leadId);
    fallbackStore.lead_stage_history = (fallbackStore.lead_stage_history || []).filter(h => h.lead_id !== leadId);
    fallbackStore.scoring_results = (fallbackStore.scoring_results || []).filter(s => s.lead_id !== leadId);
    db.writeStore(fallbackStore);
  }
  
  await logActivity('Lead deleted', 'Lead', leadId, `Deleted lead ${lead.business_name}`);
  res.json({ success: true });
});

// =========================================================================
// WEBSITE ANALYZER (Checkpoint 7)
// =========================================================================
async function verifyEmailDomain(email) {
  if (!email) return false;
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  try {
    const mxRecords = await dns.resolveMx(domain);
    return mxRecords && mxRecords.length > 0;
  } catch (err) {
    console.warn(`[server] DNS MX check failed for domain ${domain}:`, err.message);
    return false;
  }
}

function isValidBusinessEmail(email) {
  const lower = email.toLowerCase();
  const blacklistedDomains = [
    'sentry.io', 'wix.com', 'wixpress.com', 'bootstrap', 'jquery', 
    'example.com', 'domain.com', 'yourdomain.com', 'email.com', 
    'temp.com', 'test.com', 'theme.com', 'envato.com', 'themeforest.com', 
    'template.com', 'wordpress.org', 'wordpress.com', 'git.io', 'github.com', 
    'google.com', 'hubspot.com', 'shopify.com', 'squarespace.com', 
    'weebly.com', 'intercom.io', 'intercom-mail.com', 'mailchimp.com', 
    'optimizely.com', 'cloudflare.com', 'awmdelivery.com', 'exacttarget.com', 
    'marketo.com', 'salesforce.com', 'leadspedia.com', 'medium.com', 
    'wp.com', 'gravatar.com', 'automattic.com', 'elementor.com', 
    'w3.org', 'w3schools.com', 'schema.org', 'microsoft.com', 'adobe.com'
  ];
  
  if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|woff|woff2|ttf|eot)$/i.test(lower)) {
    return false;
  }
  
  const parts = lower.split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  
  const isBlacklisted = blacklistedDomains.some(blacklisted => {
    return domain === blacklisted || domain.endsWith('.' + blacklisted);
  });
  
  if (isBlacklisted) return false;
  
  const localPart = parts[0];
  const placeholders = ['placeholder', 'example', 'test', 'noreply', 'no-reply', 'admin@', 'info@template'];
  if (placeholders.some(p => localPart.includes(p))) return false;
  
  return true;
}

function extractEmailsFromHtml(html) {
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emailsFound = html.match(emailRegex) || [];
  const validEmails = emailsFound.filter(isValidBusinessEmail);
  return validEmails.map(e => e.toLowerCase());
}

function extractContactLinks(html, baseUrl) {
  const linkRegex = /href=["']([^"']+)["']/g;
  const links = new Set();
  let match;
  let baseOrigin = '';
  try {
    const parsedBase = new URL(baseUrl);
    baseOrigin = parsedBase.origin;
  } catch (e) {
    return [];
  }

  const contactKeywords = ['contact', 'about', 'support', 'info', 'touch', 'help'];

  while ((match = linkRegex.exec(html)) !== null) {
    let link = match[1].trim();
    if (!link || link.startsWith('#') || link.startsWith('javascript:') || link.startsWith('mailto:') || link.startsWith('tel:')) {
      continue;
    }

    let absoluteUrl = '';
    if (link.startsWith('http://') || link.startsWith('https://')) {
      try {
        const parsedLink = new URL(link);
        if (parsedLink.origin === baseOrigin) {
          absoluteUrl = link;
        }
      } catch (e) {}
    } else if (link.startsWith('//')) {
      absoluteUrl = 'https:' + link;
    } else {
      if (!link.startsWith('/')) {
        link = '/' + link;
      }
      absoluteUrl = baseOrigin + link;
    }

    if (absoluteUrl) {
      const lowerUrl = absoluteUrl.toLowerCase();
      const hasKeyword = contactKeywords.some(kw => lowerUrl.includes(kw));
      if (hasKeyword) {
        links.add(absoluteUrl);
      }
    }
  }

  return Array.from(links).slice(0, 3);
}

async function analyzeWebsiteForLead(lead) {
  const analysis = {
    website_exists: false, accessible: false, https_available: false,
    mobile_friendly: false, contact_present: false, contact_page: false,
    whatsapp_present: false, booking_ordering_present: false,
    missing_features: [], improvement_opportunity: '',
    checked_url: lead.public_website || '', checked_at: new Date().toISOString()
  };
  if (!lead.public_website) {
    analysis.improvement_opportunity = 'Add a public website to improve credibility.';
    analysis.missing_features = ['website'];
    return analysis;
  }
  const normalizedWebsite = lead.public_website.trim();
  const testUrls = [];
  if (normalizedWebsite.startsWith('http://') || normalizedWebsite.startsWith('https://')) {
    testUrls.push(normalizedWebsite);
  } else {
    testUrls.push(`https://${normalizedWebsite}`, `http://${normalizedWebsite}`);
  }
  let html = '';
  for (const url of testUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'WebCloserAI-Analyzer/1.0' } });
      clearTimeout(timeout);
      if (!response.ok) continue;
      analysis.website_exists = true;
      analysis.accessible = true;
      analysis.checked_url = url;
      analysis.http_status = response.status;
      if (url.startsWith('https://')) analysis.https_available = true;
      html = await response.text();
      break;
    } catch { continue; }
  }
  if (!analysis.accessible) {
    analysis.improvement_opportunity = 'Website could not be accessed. Verify the public website address.';
    analysis.missing_features = ['accessible_website'];
    return analysis;
  }
  const lowerHtml = html.toLowerCase();
  analysis.mobile_friendly = lowerHtml.includes('viewport') || lowerHtml.includes('responsive');
  analysis.contact_present = lowerHtml.includes('mailto:') || lowerHtml.includes('tel:') || lowerHtml.includes('contact');
  analysis.contact_page = lowerHtml.includes('contact us') || lowerHtml.includes('contact page') || lowerHtml.includes('href="/contact') || lowerHtml.includes('href="/about');
  analysis.whatsapp_present = lowerHtml.includes('whatsapp') || lowerHtml.includes('wa.me');
  analysis.booking_ordering_present = lowerHtml.includes('book now') || lowerHtml.includes('order now') || lowerHtml.includes('appointment') || lowerHtml.includes('reserve') || lowerHtml.includes('schedule');
  const missing = [];
  if (!analysis.mobile_friendly) missing.push('mobile-friendly design');
  if (!analysis.https_available) missing.push('HTTPS');
  if (!analysis.contact_present) missing.push('clear contact options');
  if (!analysis.contact_page) missing.push('dedicated contact page');
  if (!analysis.whatsapp_present) missing.push('WhatsApp integration');
  if (!analysis.booking_ordering_present) missing.push('booking or ordering features');
  analysis.missing_features = missing;
  analysis.improvement_opportunity = missing.length ? `Opportunity to improve: ${missing.join(', ')}.` : 'Website appears functional with contact details.';
  
  // Extract email address if present in HTML, with contact-page fallback crawling
  let extractedEmail = null;
  const homepageEmails = extractEmailsFromHtml(html);
  
  // Verify domain MX records for homepage candidates
  const verifiedHomepageEmails = [];
  for (const email of homepageEmails) {
    if (await verifyEmailDomain(email)) {
      verifiedHomepageEmails.push(email);
    }
  }

  if (verifiedHomepageEmails.length > 0) {
    extractedEmail = verifiedHomepageEmails[0];
  } else {
    const contactLinks = extractContactLinks(html, analysis.checked_url);
    for (const contactUrl of contactLinks) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const contactResponse = await fetch(contactUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'WebCloserAI-Analyzer/1.0' } });
        clearTimeout(timeout);
        if (contactResponse.ok) {
          const contactHtml = await contactResponse.text();
          const contactEmails = extractEmailsFromHtml(contactHtml);
          
          // Verify domain MX records for contact page candidates
          const verifiedContactEmails = [];
          for (const email of contactEmails) {
            if (await verifyEmailDomain(email)) {
              verifiedContactEmails.push(email);
            }
          }

          if (verifiedContactEmails.length > 0) {
            extractedEmail = verifiedContactEmails[0];
            analysis.contact_page = true;
            break;
          }
        }
      } catch (err) {
        // Skip failures and check next link
      }
    }
  }
  analysis.extracted_email = extractedEmail;

  return analysis;
}

app.post('/api/leads/:id/analyze', requireAuth, async (req, res) => {
  await reloadStore();
  const lead = (store.leads || []).find(item => item.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  try {
    const analysis = await analyzeWebsiteForLead(lead);
    lead.website_analysis = analysis;
    lead.qualification_reason = buildQualificationReason(lead);
    
    // Save scraped email if lead doesn't have one
    if (analysis.extracted_email && !lead.public_email) {
      lead.public_email = analysis.extracted_email;
      console.log(`[server] Scraped email address for lead ${lead.id}: ${lead.public_email}`);
    }

    if (!['ANALYZED','QUALIFIED','CONTACT_READY','CONTACTED','FOLLOW_UP','REPLIED','INTERESTED','REQUIREMENT_COLLECTION','MEETING_REQUIRED','MEETING_SCHEDULED','NEGOTIATION','WON','PROJECT_ACTIVE','DELIVERED','MAINTENANCE'].includes(lead.stage)) {
      lead.stage = 'ANALYZED';
      if (!lead.stage_history) lead.stage_history = [];
      lead.stage_history.unshift({ stage: 'ANALYZED', changed_at: new Date().toISOString() });
      await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: lead.id, stage: 'ANALYZED', changed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    }
    const { score, rulesTriggered } = calculateLeadScore(lead);
    lead.score = score;
    lead.priority = calculatePriority(score);
    lead.updated_at = new Date().toISOString();
    await db.updateRow('leads', lead.id, { 
      website_analysis: analysis, 
      qualification_reason: lead.qualification_reason, 
      stage: lead.stage, 
      stage_history: lead.stage_history, 
      score, 
      priority: lead.priority, 
      public_email: lead.public_email || null,
      updated_at: lead.updated_at 
    });
    await logActivity('Analysis completed', 'Lead', lead.id, `Performed website analysis for ${lead.business_name}`);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: 'Website analysis failed: ' + err.message });
  }
});

// =========================================================================
// LEAD QUALIFICATION (Checkpoint 8)
// =========================================================================
app.post('/api/leads/:id/qualify', requireAuth, async (req, res) => {
  await reloadStore();
  const lead = (store.leads || []).find(item => item.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.qualification_reason = buildQualificationReason(lead);
  const { score, rulesTriggered } = calculateLeadScore(lead);
  lead.score = score;
  lead.priority = calculatePriority(score);
  lead.stage = 'QUALIFIED';
  if (!lead.stage_history) lead.stage_history = [];
  lead.stage_history.unshift({ stage: 'QUALIFIED', changed_at: new Date().toISOString() });
  lead.updated_at = new Date().toISOString();
  await db.updateRow('leads', lead.id, { qualification_reason: lead.qualification_reason, score, priority: lead.priority, stage: 'QUALIFIED', stage_history: lead.stage_history, updated_at: lead.updated_at });
  await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: lead.id, stage: 'QUALIFIED', changed_at: new Date().toISOString(), created_at: new Date().toISOString() });
  await db.insertRow('scoring_results', { id: uuidv4(), lead_id: lead.id, score, priority: lead.priority, qualification_status: 'QUALIFIED', rules_triggered: rulesTriggered, qualification_reason: lead.qualification_reason, created_at: new Date().toISOString() });
  await logActivity('Lead qualified', 'Lead', lead.id, `Lead qualified for ${lead.business_name}`);
  res.json({ success: true, lead });
});

app.get('/api/leads/:id/scoring', requireAuth, async (req, res) => {
  const results = await db.findRows('scoring_results', { lead_id: req.params.id }, 'created_at DESC');
  res.json(results);
});

// =========================================================================
// CONTACTS (Checkpoint 5)
// =========================================================================
app.get('/api/leads/:id/contacts', requireAuth, async (req, res) => {
  const contacts = await db.findRows('contacts', { lead_id: req.params.id }, 'created_at ASC');
  res.json(contacts);
});

app.post('/api/leads/:id/contacts', requireAuth, async (req, res) => {
  const lead = await db.findRow('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { full_name, role, email, phone, whatsapp, linkedin, is_primary, notes } = req.body;
  if (!full_name) return res.status(400).json({ error: 'Contact name is required' });
  const contact = { id: uuidv4(), lead_id: req.params.id, full_name, role: role || '', email: email || '', phone: phone || '', whatsapp: whatsapp || '', linkedin: linkedin || '', is_primary: is_primary !== false, notes: notes || '', metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await db.insertRow('contacts', contact);
  await logActivity('Contact added', 'Contact', contact.id, `Added contact ${full_name} for ${lead.business_name}`);
  res.json({ success: true, contact });
});

app.put('/api/contacts/:id', requireAuth, async (req, res) => {
  const contact = await db.findRow('contacts', req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.lead_id; delete updates.created_at;
  const updated = await db.updateRow('contacts', req.params.id, updates);
  res.json({ success: true, contact: updated });
});

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  const deleted = await db.deleteRow('contacts', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

// =========================================================================
// LEAD DISCOVERY (Checkpoint 6)
// =========================================================================
app.post('/api/discover', requireAuth, async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_DEMO_KEY;
  if (!apiKey) return res.status(501).json({ error: 'Google Maps API key not configured. Set GOOGLE_MAPS_DEMO_KEY in .env', provider_status: 'NOT_CONFIGURED' });
  const { query: searchQuery, location, limit = 3 } = req.body;
  if (!searchQuery) return res.status(400).json({ error: 'Search query is required' });

  const lowerQuery = searchQuery.toLowerCase();
  if (lowerQuery.includes('web design') || lowerQuery.includes('website design') || lowerQuery.includes('seo') || lowerQuery.includes('marketing agency') || lowerQuery.includes('digital marketing') || lowerQuery.includes('software development') || lowerQuery.includes('it consultant')) {
    return res.status(400).json({ error: 'To keep Jarvis profitable and avoid competitor friction, queries related to web design, SEO, and marketing agencies are restricted. Please search for actual clients (e.g. Dentists, Restaurants, Plumbers, Roofers, Salons).' });
  }
  
  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const textQuery = searchQuery + (location ? ' in ' + location : '');
    const maxLimit = Math.min(Number(limit), 150);
    
    let results = [];
    let nextPageToken = null;
    let pagesFetched = 0;
    
    do {
      const pageSize = Math.min(maxLimit - results.length, 20);
      const requestBody = {
        textQuery,
        pageSize
      };
      if (nextPageToken) {
        requestBody.pageToken = nextPageToken;
      }
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.googleMapsUri,places.primaryType,places.types,nextPageToken'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        if (results.length > 0) break; // Return what we have so far
        const errText = await response.text();
        let parsedErr = errText;
        try { parsedErr = JSON.parse(errText); } catch {}
        return res.status(response.status).json({
          success: false,
          error: 'Google Places API request failed',
          status_code: response.status,
          endpoint: url,
          api_response: parsedErr,
          provider_status: 'ERROR'
        });
      }
      
      const data = await response.json();
      const pageResults = (data.places || [])
        .filter(place => {
          const lowerName = (place.displayName ? place.displayName.text : '').toLowerCase();
          const lowerAddress = (place.formattedAddress || '').toLowerCase();
          
          const isChain = lowerName.includes('walmart') || lowerName.includes('target') || 
                          lowerName.includes('mcdonald') || lowerName.includes('starbucks') || 
                          lowerName.includes('orkin') || lowerName.includes('terminix') || 
                          lowerName.includes('truly nolen') || lowerName.includes('subway') ||
                          lowerName.includes('cvs') || lowerName.includes('walgreens') ||
                          lowerName.includes('native pest') || lowerName.includes('pest control inc');
          if (isChain) return false;
          
          const isGov = lowerName.includes('government') || lowerName.includes('department of') || 
                        lowerName.includes('court') || lowerName.includes('police') || 
                        lowerName.includes('municipal') || lowerName.includes('city hall');
          if (isGov) return false;
          
          const isHospital = lowerName.includes('hospital') || lowerName.includes('medical center') || 
                             (lowerName.includes('clinic') && (lowerName.includes('memorial') || lowerName.includes('general')));
          if (isHospital) return false;
          
          return true;
        })
        .map(place => ({
          business_name: place.displayName ? place.displayName.text : '',
          location: place.formattedAddress || '',
          public_phone: place.nationalPhoneNumber || '',
          public_website: place.websiteUri || '',
          rating: place.rating || null,
          google_maps_url: place.googleMapsUri || '',
          category: place.primaryType || (place.types || []).slice(0, 3).join(', '),
          source: 'Google Maps Discovery',
          discovery_date: new Date().toISOString()
        }));
      
      results = results.concat(pageResults);
      nextPageToken = data.nextPageToken;
      pagesFetched++;
      
      if (pageResults.length === 0 || !nextPageToken || results.length >= maxLimit || pagesFetched >= 8) {
        break;
      }
      
      // Wait a short delay before next page request
      await new Promise(resolve => setTimeout(resolve, 300));
      
    } while (results.length < maxLimit);
    
    res.json({ success: true, results, total: results.length, provider_status: 'OK' });
  } catch (err) {
    res.status(500).json({ error: 'Discovery failed: ' + err.message, provider_status: 'ERROR' });
  }
});

// =========================================================================
// PERSISTENT JOB SCHEDULER (Checkpoint 9)
// =========================================================================
app.get('/api/jobs', requireAuth, async (req, res) => {
  const { status, type, limit = 50 } = req.query;
  const where = {};
  if (status) where.status = status;
  if (type) where.type = type;
  const jobs = await db.findRows('jobs', Object.keys(where).length ? where : null, 'scheduled_at ASC', Number(limit));
  res.json(jobs);
});

app.post('/api/jobs', requireAuth, async (req, res) => {
  const { type, payload, scheduled_at, unique_key, max_retries = 3 } = req.body;
  if (!type) return res.status(400).json({ error: 'Job type is required' });
  if (unique_key) {
    const existing = await db.findRows('jobs', { unique_key });
    if (existing.length > 0) return res.status(409).json({ error: 'Job with this unique key already exists', existing_job: existing[0] });
  }
  const now = new Date().toISOString();
  const job = { id: uuidv4(), type, payload: payload || {}, status: 'PENDING', scheduled_at: scheduled_at || now, started_at: null, completed_at: null, retry_count: 0, max_retries: Number(max_retries), error: null, unique_key: unique_key || null, created_at: now, updated_at: now };
  await db.insertRow('jobs', job);
  await logActivity('Job created', 'Job', job.id, `Scheduled ${type} job`);
  res.json({ success: true, job });
});

app.put('/api/jobs/:id', requireAuth, async (req, res) => {
  const job = await db.findRow('jobs', req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, error, started_at, completed_at } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (error !== undefined) updates.error = error;
  if (started_at) updates.started_at = started_at;
  if (completed_at) updates.completed_at = completed_at;
  if (status === 'RUNNING') updates.started_at = updates.started_at || new Date().toISOString();
  if (status === 'COMPLETED' || status === 'FAILED') updates.completed_at = new Date().toISOString();
  if (status === 'FAILED') updates.retry_count = (job.retry_count || 0) + 1;
  const updated = await db.updateRow('jobs', req.params.id, updates);
  // Record execution
  await db.insertRow('job_executions', { id: uuidv4(), job_id: job.id, status: status || job.status, started_at: updates.started_at || job.started_at, completed_at: updates.completed_at, error: updates.error || null, output: req.body.output || null, created_at: new Date().toISOString() });
  res.json({ success: true, job: updated });
});

app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  const deleted = await db.deleteRow('jobs', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

// Job recovery: find overdue/pending jobs
app.post('/api/jobs/recover', requireAuth, async (req, res) => {
  const now = new Date().toISOString();
  const pendingJobs = await db.findRows('jobs', { status: 'PENDING' });
  const overdueJobs = pendingJobs.filter(j => j.scheduled_at <= now);
  const runningJobs = await db.findRows('jobs', { status: 'RUNNING' });
  // Mark stuck RUNNING jobs as FAILED for retry
  for (const job of runningJobs) {
    if (job.retry_count < job.max_retries) {
      await db.updateRow('jobs', job.id, { status: 'PENDING', error: 'Recovered after restart', updated_at: now });
    } else {
      await db.updateRow('jobs', job.id, { status: 'FAILED', error: 'Max retries exceeded after restart', completed_at: now, updated_at: now });
    }
  }
  res.json({ success: true, overdue: overdueJobs.length, recovered_running: runningJobs.length });
});

// =========================================================================
// OUTREACH SYSTEM (Checkpoint 10)
// =========================================================================
app.get('/api/outreach/templates', requireAuth, async (req, res) => {
  const templates = await db.findRows('outreach_templates', null, 'created_at DESC');
  res.json(templates);
});

app.post('/api/outreach/templates', requireAuth, async (req, res) => {
  const { name, subject, body, channel = 'email', category, variables } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Template name and body are required' });
  const now = new Date().toISOString();
  const template = { id: uuidv4(), name, subject: subject || '', body, channel, category: category || 'general', variables: variables || [], is_active: true, metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('outreach_templates', template);
  await logActivity('Template created', 'Template', template.id, `Created outreach template: ${name}`);
  res.json({ success: true, template });
});

app.put('/api/outreach/templates/:id', requireAuth, async (req, res) => {
  const tmpl = await db.findRow('outreach_templates', req.params.id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;
  const updated = await db.updateRow('outreach_templates', req.params.id, updates);
  res.json({ success: true, template: updated });
});

app.delete('/api/outreach/templates/:id', requireAuth, async (req, res) => {
  const deleted = await db.deleteRow('outreach_templates', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Template not found' });
  res.json({ success: true });
});

// Outreach Messages
app.get('/api/outreach/messages', requireAuth, async (req, res) => {
  const { lead_id, status, limit = 50 } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (status) where.status = status;
  const messages = await db.findRows('outreach_messages', Object.keys(where).length ? where : null, 'created_at DESC', Number(limit));
  res.json(messages);
});

app.post('/api/outreach/messages', requireAuth, async (req, res) => {
  const { lead_id, template_id, contact_id, subject, body, channel = 'email', personalization } = req.body;
  if (!lead_id || !body) return res.status(400).json({ error: 'Lead ID and message body are required' });
  
  const lead = await db.findRow('leads', lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.opt_out) return res.status(403).json({ error: 'Lead has opted out of communications' });

  // Check for duplicate outreach
  const existingMessages = await db.findRows('outreach_messages', { lead_id });
  const recentDuplicate = existingMessages.find(m => m.body === body && m.status !== 'FAILED');
  if (recentDuplicate) return res.status(409).json({ error: 'Duplicate outreach message detected' });

  // Check daily limit
  const dailyLimit = Number(getSetting('daily_contact_limit', '10'));
  const today = new Date().toISOString().split('T')[0];
  const todayMessages = existingMessages.filter(m => {
    if (!m.created_at) return false;
    const dateStr = typeof m.created_at === 'string' ? m.created_at : m.created_at.toISOString();
    return dateStr.startsWith(today) && m.status === 'SENT';
  });
  if (todayMessages.length >= dailyLimit) return res.status(429).json({ error: `Daily contact limit (${dailyLimit}) reached` });

  const now = new Date().toISOString();
  const message = { id: uuidv4(), lead_id, contact_id: contact_id || null, template_id: template_id || null, channel, subject: subject || '', body, personalization: personalization || {}, status: 'DRAFT', sent_at: null, error: null, external_id: null, metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('outreach_messages', message);
  await logActivity('Outreach drafted', 'Outreach', message.id, `Draft outreach for ${lead.business_name}`);
  res.json({ success: true, message });
});

app.put('/api/outreach/messages/:id/approve', requireAuth, async (req, res) => {
  const msg = await db.findRow('outreach_messages', req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.status !== 'DRAFT') return res.status(400).json({ error: 'Only draft messages can be approved' });
  const updated = await db.updateRow('outreach_messages', req.params.id, { status: 'QUEUED', updated_at: new Date().toISOString() });
  await logActivity('Outreach approved', 'Outreach', msg.id, 'Message approved for sending');
  res.json({ success: true, message: updated });
});

async function getValidGmailToken() {
  const tokens = await db.findRows('oauth_tokens', { provider: 'gmail' }, 'created_at DESC');
  if (tokens.length === 0) return null;
  const token = tokens[0];
  
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  if (expiresAt.getTime() - now.getTime() > 60 * 1000) {
    return token.access_token;
  }
  
  console.log('[server] Gmail access token expired, attempting refresh...');
  if (!token.refresh_token) {
    throw new Error('Access token is expired and no refresh token is available.');
  }
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to refresh Google OAuth token: ${errText}`);
  }
  
  const data = await response.json();
  const newAccessToken = data.access_token;
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  
  await db.updateRow('oauth_tokens', token.id, {
    access_token: newAccessToken,
    expires_at: newExpiresAt,
    updated_at: new Date().toISOString()
  });
  
  console.log('[server] Gmail access token refreshed successfully.');
  return newAccessToken;
}

async function transitionLeadToContacted(leadId) {
  const lead = await db.findRow('leads', leadId);
  if (!lead) return;
  
  const earlyStages = ['NEW', 'DISCOVERED', 'ANALYZED', 'QUALIFIED', 'CONTACT_READY'];
  if (earlyStages.includes(lead.stage)) {
    const now = new Date().toISOString();
    const stageHistory = lead.stage_history || [];
    stageHistory.unshift({ stage: 'CONTACTED', changed_at: now });
    
    await db.updateRow('leads', lead.id, {
      stage: 'CONTACTED',
      stage_history: stageHistory,
      last_contact_date: now,
      updated_at: now
    });
    
    await db.insertRow('lead_stage_history', {
      id: uuidv4(),
      lead_id: lead.id,
      stage: 'CONTACTED',
      changed_at: now,
      created_at: now
    });
    
    await logActivity('Stage changed', 'Lead', lead.id, `Lead stage changed to CONTACTED (email sent)`);
    await reloadStore();
  }
}

app.put('/api/outreach/messages/:id/send', requireAuth, async (req, res) => {
  const msg = await db.findRow('outreach_messages', req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!['QUEUED', 'DRAFT', 'FAILED'].includes(msg.status)) return res.status(400).json({ error: 'Message is not in sendable state' });
  
  let accessToken = null;
  try {
    accessToken = await getValidGmailToken();
  } catch (refreshErr) {
    console.error('[server] Failed to refresh Gmail token:', refreshErr.message);
    return res.status(500).json({ error: `Gmail authentication error: ${refreshErr.message}` });
  }

  if (accessToken) {
    const lead = await db.findRow('leads', msg.lead_id);
    if (lead && lead.public_email) {
      // 1. Timezone & Local Business Hours Compliance (9 AM - 11 AM, Weekdays)
      if (lead.location) {
        const getLeadTimezoneOffset = (loc) => {
          const locLower = loc.toLowerCase();
          if (locLower.includes('miami') || locLower.includes('boston') || locLower.includes('atlanta') || 
              locLower.includes('orlando') || locLower.includes('charlotte') || locLower.includes('new york') || 
              locLower.includes('philadelphia') || locLower.includes('washington') || locLower.includes('columbus') || 
              locLower.includes('jacksonville')) {
            return 'America/New_York';
          }
          if (locLower.includes('austin') || locLower.includes('chicago') || locLower.includes('dallas') || 
              locLower.includes('houston') || locLower.includes('nashville') || locLower.includes('fort worth') || 
              locLower.includes('san antonio') || locLower.includes('indianapolis')) {
            return 'America/Chicago';
          }
          if (locLower.includes('denver') || locLower.includes('phoenix') || locLower.includes('las vegas') || 
              locLower.includes('salt lake')) {
            return 'America/Denver';
          }
          if (locLower.includes('seattle') || locLower.includes('san diego') || locLower.includes('los angeles') || 
              locLower.includes('san francisco') || locLower.includes('portland') || locLower.includes('san jose')) {
            return 'America/Los_Angeles';
          }
          return 'America/New_York';
        };
        
        try {
          const tz = getLeadTimezoneOffset(lead.location);
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            hour12: false,
            weekday: 'long'
          });
          const parts = formatter.formatToParts(new Date());
          const localHour = Number(parts.find(p => p.type === 'hour').value);
          const localWeekday = parts.find(p => p.type === 'weekday').value;
          
          const isWeekend = localWeekday === 'Saturday' || localWeekday === 'Sunday';
          const isBusinessHours = localHour >= 9 && localHour < 11;
          
          if (isWeekend || !isBusinessHours) {
            return res.status(400).json({ error: `Timing Compliance: Target time in ${lead.location} is outside business hours (9 AM - 11 AM, Mon-Fri). Current day there: ${localWeekday}, hour: ${localHour}:00.` });
          }
        } catch (err) {
          console.error('[server] Timing check failed:', err.message);
        }
      }

      // 2. Hard Stop Conditions (Bounce/Failure Rates)
      if (lead.source && lead.source.startsWith('Autopilot:')) {
        const match = lead.source.match(/Autopilot: (.+) in (.+)/);
        if (match) {
          const campaignQuery = match[1];
          const campaignLocation = match[2];
          const key = `${campaignQuery}_in_${campaignLocation}`.toLowerCase().replace(/\s+/g, '_');
          if (fs.existsSync(METRICS_FILE)) {
            const metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
            const m = metrics[key];
            if (m && m.sent >= 10) {
              const bounceRate = (m.bounced || 0) / m.sent;
              const failedRate = (m.failed || 0) / (m.sent + m.failed);
              if (bounceRate > 0.10) {
                return res.status(400).json({ error: `Campaign paused: Bounce rate exceeds 10% (${(bounceRate * 100).toFixed(1)}%).` });
              }
              if (failedRate > 0.15) {
                return res.status(400).json({ error: `Campaign paused: Send failure rate exceeds 15% (${(failedRate * 100).toFixed(1)}%).` });
              }
            }
          }
        }
      }

      // 3. Domain Warm-up Limits
      const allMessages = await db.findRows('outreach_messages', { status: 'SENT' });
      const todayStr = new Date().toISOString().split('T')[0];
      const sentToday = allMessages.filter(m => m.sent_at && m.sent_at.startsWith(todayStr)).length;
      
      const tokensList = await db.findRows('oauth_tokens', { provider: 'gmail' }, 'created_at DESC');
      if (tokensList.length > 0) {
        const token = tokensList[0];
        const ageDays = (Date.now() - new Date(token.created_at).getTime()) / (1000 * 60 * 60 * 24);
        let dailyLimit = 100;
        if (ageDays <= 3) dailyLimit = 10;
        else if (ageDays <= 7) dailyLimit = 20;
        else if (ageDays <= 14) dailyLimit = 40;
        
        if (sentToday >= dailyLimit) {
          return res.status(400).json({ error: `Warm-up limit reached: Max ${dailyLimit} emails/day for this domain. Sent today: ${sentToday}.` });
        }
      }

      // 4. Subject Line Rotation
      const recentSends = allMessages.slice(-20);
      const sameSubjectCount = recentSends.filter(m => m.subject === msg.subject).length;
      if (recentSends.length >= 10 && (sameSubjectCount / recentSends.length) > 0.20) {
        msg.subject = `Quick suggestion: ${msg.subject}`;
      }
      // Validate domain MX records to protect sender reputation
      const isDomainValid = await verifyEmailDomain(lead.public_email);
      if (!isDomainValid) {
        const now = new Date().toISOString();
        const updated = await db.updateRow('outreach_messages', req.params.id, {
          status: 'FAILED',
          error: 'Email verification failed: Domain has no valid MX records.',
          updated_at: now
        });
        
        // Increment failed metrics
        if (lead && lead.source && lead.source.startsWith('Autopilot:')) {
          const match = lead.source.match(/Autopilot: (.+) in (.+)/);
          if (match) {
            await incrementCampaignMetric(match[1], match[2], 'failed', 1, 'MX verification failed');
          }
        }

        await logActivity('Outreach failed (MX check)', 'Outreach', msg.id, `Blocked sending to ${lead.public_email} - domain has no valid MX records.`);
        return res.status(400).json({ error: 'Email verification failed: Domain has no valid MX records.' });
      }

      try {
        const toEmail = lead.public_email;
        const subject = msg.subject || 'Outreach Pitch';
        const body = msg.body;
        
        // Construct MIME email
        const rawMessage = [
          `To: ${toEmail}`,
          `Subject: ${subject}`,
          'Content-Type: text/html; charset=utf-8',
          'MIME-Version: 1.0',
          '',
          body.replace(/\n/g, '<br>')
        ].join('\r\n');

        const encodedMessage = Buffer.from(rawMessage)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        const gmailUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
        const gmailRes = await fetch(gmailUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ raw: encodedMessage })
        });
        
        if (!gmailRes.ok) {
          const errText = await gmailRes.text();
          throw new Error(`Gmail API error: ${errText}`);
        }
        
        const gmailData = await gmailRes.json();
        const updated = await db.updateRow('outreach_messages', req.params.id, { 
          status: 'SENT', 
          sent_at: new Date().toISOString(), 
          updated_at: new Date().toISOString(),
          error: null,
          metadata: JSON.stringify({ gmail_id: gmailData.id, thread_id: gmailData.threadId })
        });
        await logActivity('Outreach sent via Gmail', 'Outreach', msg.id, `Email sent to ${toEmail} using connected Gmail account.`);
        
        // Increment metrics
        if (lead && lead.source && lead.source.startsWith('Autopilot:')) {
          const match = lead.source.match(/Autopilot: (.+) in (.+)/);
          if (match) {
            await incrementCampaignMetric(match[1], match[2], 'sent');
            await incrementCampaignMetric(match[1], match[2], 'delivered');
          }
        }

        await transitionLeadToContacted(msg.lead_id);
        
        return res.json({ success: true, message: updated, note: `Email successfully sent via Gmail API to ${toEmail}!` });
      } catch (gmailErr) {
        console.error('[server] Gmail sending failed:', gmailErr.message);
        const now = new Date().toISOString();
        await db.updateRow('outreach_messages', req.params.id, {
          status: 'FAILED',
          error: `Gmail sending failed: ${gmailErr.message}`,
          updated_at: now
        });

        // Increment failed metrics
        if (lead && lead.source && lead.source.startsWith('Autopilot:')) {
          const match = lead.source.match(/Autopilot: (.+) in (.+)/);
          if (match) {
            await incrementCampaignMetric(match[1], match[2], 'failed', 1, gmailErr.message);
          }
        }

        return res.status(500).json({ error: `Gmail sending failed: ${gmailErr.message}` });
      }
    }
  }

  // Fallback to beta mode if Gmail is not connected or lead lacks email
  const updated = await db.updateRow('outreach_messages', req.params.id, { status: 'SENT', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await logActivity('Outreach sent', 'Outreach', msg.id, 'Message marked as sent (beta fallback)');
  
  await transitionLeadToContacted(msg.lead_id);
  
  let fallbackNote = 'Message marked as sent (beta mode)';
  if (!accessToken) {
    fallbackNote = 'Message marked as sent (beta mode - Gmail account not connected)';
  } else {
    fallbackNote = 'Message marked as sent (beta mode - lead lacks email address)';
  }
  
  res.json({ success: true, message: updated, note: fallbackNote });
});

// =========================================================================
// CONVERSATIONS (Checkpoint 10)
// =========================================================================
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { lead_id } = req.query;
  const where = lead_id ? { lead_id } : null;
  const convos = await db.findRows('conversations', where, 'created_at DESC');
  res.json(convos);
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { lead_id, contact_id, direction, channel, subject, body, external_id } = req.body;
  if (!lead_id || !body) return res.status(400).json({ error: 'Lead ID and body are required' });
  const now = new Date().toISOString();
  const convo = { id: uuidv4(), lead_id, contact_id: contact_id || null, direction: direction || 'outbound', channel: channel || 'email', subject: subject || '', body, external_id: external_id || null, thread_id: req.body.thread_id || null, metadata: {}, created_at: now };
  await db.insertRow('conversations', convo);
  if (direction === 'inbound') {
    await logActivity('Reply received', 'Conversation', convo.id, `Reply from lead ${lead_id}`);
  }
  res.json({ success: true, conversation: convo });
});

// =========================================================================
// FOLLOW-UPS (Checkpoint 12)
// =========================================================================
app.get('/api/follow-ups', requireAuth, async (req, res) => {
  const { lead_id, status } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (status) where.status = status;
  const followUps = await db.findRows('follow_ups', Object.keys(where).length ? where : null, 'scheduled_at ASC');
  res.json(followUps);
});

app.post('/api/follow-ups', requireAuth, async (req, res) => {
  const { lead_id, sequence_number, scheduled_at, template_id, message_body } = req.body;
  if (!lead_id || !scheduled_at) return res.status(400).json({ error: 'Lead ID and scheduled_at are required' });
  const lead = await db.findRow('leads', lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.opt_out) return res.status(403).json({ error: 'Lead has opted out' });
  const maxFollowUps = Number(getSetting('max_follow_ups', '4'));
  const existing = await db.findRows('follow_ups', { lead_id });
  if (existing.length >= maxFollowUps) return res.status(400).json({ error: `Maximum follow-ups (${maxFollowUps}) reached` });
  const now = new Date().toISOString();
  const followUp = { id: uuidv4(), lead_id, sequence_number: sequence_number || existing.length + 1, scheduled_at, status: 'PENDING', template_id: template_id || null, message_body: message_body || '', sent_at: null, result: null, metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('follow_ups', followUp);
  // Schedule as a job
  await db.insertRow('jobs', { id: uuidv4(), type: 'follow_up', payload: { follow_up_id: followUp.id, lead_id }, status: 'PENDING', scheduled_at, started_at: null, completed_at: null, retry_count: 0, max_retries: 3, error: null, unique_key: `follow_up_${followUp.id}`, created_at: now, updated_at: now });
  await logActivity('Follow-up scheduled', 'FollowUp', followUp.id, `Follow-up #${followUp.sequence_number} scheduled for ${lead.business_name}`);
  res.json({ success: true, follow_up: followUp });
});

app.put('/api/follow-ups/:id', requireAuth, async (req, res) => {
  const fu = await db.findRow('follow_ups', req.params.id);
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.lead_id; delete updates.created_at;
  const updated = await db.updateRow('follow_ups', req.params.id, updates);
  res.json({ success: true, follow_up: updated });
});

app.post('/api/follow-ups/:id/cancel', requireAuth, async (req, res) => {
  const fu = await db.findRow('follow_ups', req.params.id);
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  await db.updateRow('follow_ups', req.params.id, { status: 'CANCELLED', updated_at: new Date().toISOString() });
  res.json({ success: true });
});

// =========================================================================
// REQUIREMENTS (Checkpoint 13)
// =========================================================================
app.get('/api/requirements', requireAuth, async (req, res) => {
  const { lead_id } = req.query;
  const where = lead_id ? { lead_id } : null;
  const reqs = await db.findRows('requirements', where, 'created_at DESC');
  res.json(reqs);
});

app.get('/api/requirements/:id', requireAuth, async (req, res) => {
  const req_ = await db.findRow('requirements', req.params.id);
  if (!req_) return res.status(404).json({ error: 'Requirement not found' });
  res.json(req_);
});

app.post('/api/requirements', requireAuth, async (req, res) => {
  const { lead_id, business_details, website_purpose, pages, features, design_preferences, brand_colors, logo_url, content_notes, images_notes, budget, deadline, domain_preference, hosting_preference, notes } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'Lead ID is required' });
  const now = new Date().toISOString();
  const requirement = { id: uuidv4(), lead_id, business_details: business_details || '', website_purpose: website_purpose || '', pages: pages || [], features: features || [], design_preferences: design_preferences || {}, brand_colors: brand_colors || '', logo_url: logo_url || '', content_notes: content_notes || '', images_notes: images_notes || '', budget: budget || '', deadline: deadline || '', domain_preference: domain_preference || '', hosting_preference: hosting_preference || '', notes: notes || '', status: 'DRAFT', created_at: now, updated_at: now };
  await db.insertRow('requirements', requirement);
  await logActivity('Requirements created', 'Requirement', requirement.id, `Requirements drafted for lead ${lead_id}`);
  res.json({ success: true, requirement });
});

app.put('/api/requirements/:id', requireAuth, async (req, res) => {
  const existing = await db.findRow('requirements', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Requirement not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.lead_id; delete updates.created_at;
  const updated = await db.updateRow('requirements', req.params.id, updates);
  await logActivity('Requirements updated', 'Requirement', req.params.id, `Requirements updated (status: ${updates.status || existing.status})`);
  res.json({ success: true, requirement: updated });
});

// =========================================================================
// MEETINGS (Checkpoint 14 & 15)
// =========================================================================
app.get('/api/meetings', requireAuth, async (req, res) => {
  const { lead_id, status } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (status) where.status = status;
  const meetings = await db.findRows('meetings', Object.keys(where).length ? where : null, 'scheduled_at ASC');
  res.json(meetings);
});

app.post('/api/meetings', requireAuth, async (req, res) => {
  const { lead_id, contact_id, title, description, scheduled_at, duration_minutes = 30, location, meeting_url, escalation_reason } = req.body;
  if (!lead_id || !scheduled_at) return res.status(400).json({ error: 'Lead ID and scheduled_at are required' });
  const lead = await db.findRow('leads', lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const now = new Date().toISOString();
  const meeting = { id: uuidv4(), lead_id, contact_id: contact_id || null, title: title || `Meeting with ${lead.business_name}`, description: description || '', scheduled_at, duration_minutes, location: location || '', meeting_url: meeting_url || '', escalation_reason: escalation_reason || '', status: 'SCHEDULED', external_event_id: null, outcome: null, notes: '', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('meetings', meeting);
  // Update lead stage if not already past MEETING_SCHEDULED
  if (['INTERESTED','REQUIREMENT_COLLECTION','MEETING_REQUIRED'].includes(lead.stage)) {
    await db.updateRow('leads', lead_id, { stage: 'MEETING_SCHEDULED', updated_at: now });
    await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id, stage: 'MEETING_SCHEDULED', changed_at: now, created_at: now });
  }
  await logActivity('Meeting created', 'Meeting', meeting.id, `Meeting scheduled with ${lead.business_name}: ${meeting.title}`);
  // Create notification
  await db.insertRow('notifications', { id: uuidv4(), user_id: null, type: 'meeting', title: 'Meeting Scheduled', message: `Meeting with ${lead.business_name} at ${scheduled_at}`, entity_type: 'Meeting', entity_id: meeting.id, is_read: false, created_at: now });
  res.json({ success: true, meeting });
});

app.put('/api/meetings/:id', requireAuth, async (req, res) => {
  const meeting = await db.findRow('meetings', req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.lead_id; delete updates.created_at;
  const updated = await db.updateRow('meetings', req.params.id, updates);
  res.json({ success: true, meeting: updated });
});

app.delete('/api/meetings/:id', requireAuth, async (req, res) => {
  const deleted = await db.deleteRow('meetings', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Meeting not found' });
  await logActivity('Meeting cancelled', 'Meeting', req.params.id, 'Meeting deleted');
  res.json({ success: true });
});

// Meeting escalation triggers (Checkpoint 14)
app.post('/api/leads/:id/escalate', requireAuth, async (req, res) => {
  const lead = await db.findRow('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { reason } = req.body;
  const validReasons = ['unclear_requirements', 'complex_project', 'client_request', 'high_value', 'custom_integration', 'manual_escalation'];
  const escalationReason = validReasons.includes(reason) ? reason : 'manual_escalation';
  await db.updateRow('leads', req.params.id, { stage: 'MEETING_REQUIRED', updated_at: new Date().toISOString() });
  await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: lead.id, stage: 'MEETING_REQUIRED', changed_at: new Date().toISOString(), notes: escalationReason, created_at: new Date().toISOString() });
  await logActivity('Meeting escalated', 'Lead', lead.id, `Meeting required: ${escalationReason} for ${lead.business_name}`);
  await db.insertRow('notifications', { id: uuidv4(), user_id: null, type: 'escalation', title: 'Meeting Escalation', message: `${lead.business_name}: ${escalationReason}`, entity_type: 'Lead', entity_id: lead.id, is_read: false, created_at: new Date().toISOString() });
  res.json({ success: true, reason: escalationReason });
});

// =========================================================================
// CLIENT BRIEFS (Checkpoint 16)
// =========================================================================
app.get('/api/client-briefs', requireAuth, async (req, res) => {
  const { lead_id } = req.query;
  const where = lead_id ? { lead_id } : null;
  const briefs = await db.findRows('client_briefs', where, 'created_at DESC');
  res.json(briefs);
});

app.post('/api/client-briefs/generate', requireAuth, async (req, res) => {
  const { lead_id } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'Lead ID is required' });
  const lead = await db.findRow('leads', lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const requirements = await db.findRows('requirements', { lead_id });
  const conversations = await db.findRows('conversations', { lead_id }, 'created_at ASC');
  const meetings = await db.findRows('meetings', { lead_id });
  const req_ = requirements[0] || {};
  const now = new Date().toISOString();
  
  const brief = {
    id: uuidv4(), lead_id,
    business_summary: `${lead.business_name} — ${lead.category || 'Uncategorized'} business located in ${lead.location || 'Unknown location'}. Source: ${lead.source || 'Direct'}. Current stage: ${lead.stage}.`,
    lead_source: lead.source || 'Direct',
    conversation_summary: conversations.length > 0 ? `${conversations.length} messages exchanged. Latest: ${conversations[conversations.length - 1].body.substring(0, 200)}` : 'No conversations recorded.',
    known_requirements: req_.pages ? `Pages: ${Array.isArray(req_.pages) ? req_.pages.join(', ') : req_.pages}. Features: ${Array.isArray(req_.features) ? req_.features.join(', ') : req_.features || 'TBD'}` : 'Requirements not yet collected.',
    budget: req_.budget || 'Not discussed',
    deadline: req_.deadline || 'Not set',
    clarification_questions: !req_.id ? ['What is the purpose of the website?','What pages are needed?','Any design preferences?','Budget range?','Timeline?'] : [],
    meeting_objective: meetings.length > 0 ? 'Review progress and address open items' : 'Initial discovery — understand business needs and present capabilities',
    suggested_next_action: !req_.id ? 'Collect detailed requirements' : (req_.status === 'CONFIRMED' ? 'Create project and quotation' : 'Clarify requirements with client'),
    status: 'GENERATED', metadata: {},
    created_at: now, updated_at: now
  };
  
  await db.insertRow('client_briefs', brief);
  await logActivity('Brief generated', 'ClientBrief', brief.id, `Client brief generated for ${lead.business_name}`);
  res.json({ success: true, brief });
});

// =========================================================================
// PROJECTS (Checkpoint 17)
// =========================================================================
const PROJECT_STATUSES = ['PLANNING','DESIGN','DEVELOPMENT','TESTING','CLIENT_REVIEW','REVISION','READY_TO_DEPLOY','DEPLOYED','DELIVERED','CANCELLED'];

app.get('/api/projects', requireAuth, async (req, res) => {
  const { lead_id, status } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (status) where.status = status;
  const projects = await db.findRows('projects', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(projects);
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await db.findRow('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.post('/api/projects', requireAuth, async (req, res) => {
  const { lead_id, name, description, requirements_id, pages, features, deadline, preview_url, production_url } = req.body;
  if (!lead_id || !name) return res.status(400).json({ error: 'Lead ID and project name are required' });
  const now = new Date().toISOString();
  const project = { id: uuidv4(), lead_id, name, description: description || '', requirements_id: requirements_id || null, pages: pages || [], features: features || [], status: 'PLANNING', status_history: [{ status: 'PLANNING', changed_at: now }], deadline: deadline || null, preview_url: preview_url || '', production_url: production_url || '', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('projects', project);
  // Update lead stage
  await db.updateRow('leads', lead_id, { stage: 'PROJECT_ACTIVE', updated_at: now });
  await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id, stage: 'PROJECT_ACTIVE', changed_at: now, created_at: now });
  await logActivity('Project created', 'Project', project.id, `Project created: ${name}`);
  res.json({ success: true, project });
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
  const project = await db.findRow('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.lead_id; delete updates.created_at;
  if (updates.status && PROJECT_STATUSES.includes(updates.status) && updates.status !== project.status) {
    const history = project.status_history || [];
    history.push({ status: updates.status, changed_at: new Date().toISOString() });
    updates.status_history = history;
  }
  const updated = await db.updateRow('projects', req.params.id, updates);
  await logActivity('Project updated', 'Project', req.params.id, `Project updated: ${updates.status || 'details changed'}`);
  res.json({ success: true, project: updated });
});

// Project Tasks
app.get('/api/projects/:id/tasks', requireAuth, async (req, res) => {
  const tasks = await db.findRows('project_tasks', { project_id: req.params.id }, 'created_at ASC');
  res.json(tasks);
});

app.post('/api/projects/:id/tasks', requireAuth, async (req, res) => {
  const project = await db.findRow('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { title, description, status = 'TODO', priority = 'MEDIUM', assignee, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const now = new Date().toISOString();
  const task = { id: uuidv4(), project_id: req.params.id, title, description: description || '', status, priority, assignee: assignee || '', due_date: due_date || null, created_at: now, updated_at: now };
  await db.insertRow('project_tasks', task);
  res.json({ success: true, task });
});

app.put('/api/project-tasks/:id', requireAuth, async (req, res) => {
  const task = await db.findRow('project_tasks', req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.project_id; delete updates.created_at;
  const updated = await db.updateRow('project_tasks', req.params.id, updates);
  res.json({ success: true, task: updated });
});

// =========================================================================
// DEMOS, FEEDBACK, REVISIONS (Checkpoint 18)
// =========================================================================
app.get('/api/demos', requireAuth, async (req, res) => {
  const { project_id } = req.query;
  const where = project_id ? { project_id } : null;
  const demos = await db.findRows('demos', where, 'created_at DESC');
  res.json(demos);
});

app.post('/api/demos', requireAuth, async (req, res) => {
  const { project_id, demo_url, description, expires_at } = req.body;
  if (!project_id || !demo_url) return res.status(400).json({ error: 'Project ID and demo URL are required' });
  const now = new Date().toISOString();
  const demo = { id: uuidv4(), project_id, demo_url, description: description || '', expires_at: expires_at || null, status: 'ACTIVE', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('demos', demo);
  await logActivity('Demo created', 'Demo', demo.id, `Demo created for project ${project_id}`);
  res.json({ success: true, demo });
});

app.get('/api/feedback', requireAuth, async (req, res) => {
  const { demo_id, project_id, lead_id } = req.query;
  const where = {};
  if (demo_id) where.demo_id = demo_id;
  if (project_id) where.project_id = project_id;
  if (lead_id) where.lead_id = lead_id;
  const fb = await db.findRows('feedback', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(fb);
});

app.post('/api/feedback', requireAuth, async (req, res) => {
  const { demo_id, project_id, lead_id, rating, comments, items } = req.body;
  if (!project_id) return res.status(400).json({ error: 'Project ID is required' });
  const now = new Date().toISOString();
  const fb = { id: uuidv4(), demo_id: demo_id || null, project_id, lead_id: lead_id || null, rating: rating || null, comments: comments || '', items: items || [], status: 'SUBMITTED', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('feedback', fb);
  await logActivity('Feedback received', 'Feedback', fb.id, `Feedback for project ${project_id}`);
  res.json({ success: true, feedback: fb });
});

// Revisions
app.get('/api/revisions', requireAuth, async (req, res) => {
  const { project_id } = req.query;
  const where = project_id ? { project_id } : null;
  const revisions = await db.findRows('revisions', where, 'revision_number ASC');
  res.json(revisions);
});

app.post('/api/revisions', requireAuth, async (req, res) => {
  const { project_id, description, requested_changes } = req.body;
  if (!project_id) return res.status(400).json({ error: 'Project ID is required' });
  const existing = await db.findRows('revisions', { project_id });
  const revNum = existing.length + 1;
  const now = new Date().toISOString();
  const revision = { id: uuidv4(), project_id, revision_number: revNum, description: description || '', requested_changes: requested_changes || [], status: 'REQUESTED', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('revisions', revision);
  await db.updateRow('projects', project_id, { status: 'REVISION', updated_at: now });
  await logActivity('Revision requested', 'Revision', revision.id, `Revision #${revNum} requested for project ${project_id}`);
  res.json({ success: true, revision });
});

app.put('/api/revisions/:id', requireAuth, async (req, res) => {
  const rev = await db.findRow('revisions', req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revision not found' });
  const validStatuses = ['REQUESTED','PLANNED','IN_PROGRESS','COMPLETED','APPROVED'];
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  if (updates.status && !validStatuses.includes(updates.status)) return res.status(400).json({ error: 'Invalid revision status' });
  delete updates.id; delete updates.project_id; delete updates.created_at;
  const updated = await db.updateRow('revisions', req.params.id, updates);
  res.json({ success: true, revision: updated });
});

// =========================================================================
// QUOTATIONS (Checkpoint 19)
// =========================================================================
app.get('/api/quotations', requireAuth, async (req, res) => {
  const { lead_id, project_id } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (project_id) where.project_id = project_id;
  const quotes = await db.findRows('quotations', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(quotes);
});

app.post('/api/quotations', requireAuth, async (req, res) => {
  const { lead_id, project_id, items, base_price, discount_percentage = 0, discount_amount = 0, advance_percentage, validity_days = 30, notes } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'Lead ID is required' });
  const minimumPrice = Number(getSetting('minimum_acceptable_price', '500'));
  const defaultAdvance = Number(getSetting('default_advance_percentage', '50'));
  const advancePct = advance_percentage != null ? Number(advance_percentage) : defaultAdvance;
  
  // Calculate final price
  let subtotal = Number(base_price || 0);
  const parsedItems = items || [];
  if (parsedItems.length > 0 && !base_price) {
    subtotal = parsedItems.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
  }
  const discountPct = Number(discount_percentage);
  const discountAmt = Number(discount_amount) || (subtotal * discountPct / 100);
  const finalPrice = Math.max(0, subtotal - discountAmt);
  const advanceAmount = Math.round(finalPrice * advancePct / 100);
  const balance = finalPrice - advanceAmount;
  
  const now = new Date().toISOString();
  const validUntil = new Date(Date.now() + Number(validity_days) * 86400000).toISOString();
  
  const needsApproval = finalPrice < minimumPrice || discountPct > 20;
  
  const quotation = { id: uuidv4(), lead_id, project_id: project_id || null, base_price: subtotal, discount_percentage: discountPct, discount_amount: discountAmt, final_price: finalPrice, advance_percentage: advancePct, advance_amount: advanceAmount, balance, validity_date: validUntil, status: needsApproval ? 'NEEDS_APPROVAL' : 'DRAFT', notes: notes || '', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('quotations', quotation);
  
  // Save line items
  for (const item of parsedItems) {
    await db.insertRow('quotation_items', { id: uuidv4(), quotation_id: quotation.id, description: item.description || '', quantity: item.quantity || 1, unit_price: item.price || 0, total: (item.price || 0) * (item.quantity || 1), created_at: now });
  }
  
  if (needsApproval) {
    await db.insertRow('approvals', { id: uuidv4(), entity_type: 'Quotation', entity_id: quotation.id, reason: finalPrice < minimumPrice ? 'Price below minimum' : 'Large discount applied', status: 'PENDING', requested_at: now, decided_at: null, decided_by: null, notes: '', created_at: now, updated_at: now });
    await logActivity('Approval requested', 'Quotation', quotation.id, `Quotation needs approval: ${finalPrice < minimumPrice ? 'below minimum price' : 'large discount'}`);
  }
  
  await logActivity('Quotation created', 'Quotation', quotation.id, `Quotation created: $${finalPrice}`);
  res.json({ success: true, quotation, needs_approval: needsApproval });
});

app.put('/api/quotations/:id', requireAuth, async (req, res) => {
  const q = await db.findRow('quotations', req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;
  const updated = await db.updateRow('quotations', req.params.id, updates);
  res.json({ success: true, quotation: updated });
});

// =========================================================================
// DEALS (Checkpoint 20)
// =========================================================================
app.get('/api/deals', requireAuth, async (req, res) => {
  const { lead_id, status } = req.query;
  const where = {};
  if (lead_id) where.lead_id = lead_id;
  if (status) where.status = status;
  const deals = await db.findRows('deals', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(deals);
});

app.post('/api/deals', requireAuth, async (req, res) => {
  const { lead_id, quotation_id, project_id, offered_price, counteroffer, final_price, notes, probability, expected_close_date } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'Lead ID is required' });
  const now = new Date().toISOString();
  const deal = { id: uuidv4(), lead_id, quotation_id: quotation_id || null, project_id: project_id || null, offered_price: Number(offered_price || 0), counteroffer: counteroffer ? Number(counteroffer) : null, final_price: final_price ? Number(final_price) : null, status: 'OPEN', notes: notes || '', probability: probability ? Number(probability) : 50, expected_close_date: expected_close_date || null, won_reason: '', lost_reason: '', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('deals', deal);
  await logActivity('Deal created', 'Deal', deal.id, `Deal opened for lead ${lead_id}: $${offered_price}`);
  res.json({ success: true, deal });
});

app.put('/api/deals/:id', requireAuth, async (req, res) => {
  const deal = await db.findRow('deals', req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;
  
  // Handle won/lost transitions
  if (updates.status === 'WON' && deal.status !== 'WON') {
    await db.updateRow('leads', deal.lead_id, { stage: 'WON', updated_at: new Date().toISOString() });
    await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: deal.lead_id, stage: 'WON', changed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    await logActivity('Deal won', 'Deal', deal.id, `Deal won: $${updates.final_price || deal.final_price || deal.offered_price}`);
  }
  if (updates.status === 'LOST' && deal.status !== 'LOST') {
    await db.updateRow('leads', deal.lead_id, { stage: 'LOST', updated_at: new Date().toISOString() });
    await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: deal.lead_id, stage: 'LOST', changed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    await logActivity('Deal lost', 'Deal', deal.id, `Deal lost: ${updates.lost_reason || 'No reason specified'}`);
  }
  
  const updated = await db.updateRow('deals', req.params.id, updates);
  res.json({ success: true, deal: updated });
});

// =========================================================================
// APPROVALS (Checkpoint 20)
// =========================================================================
app.get('/api/approvals', requireAuth, async (req, res) => {
  const { status, entity_type } = req.query;
  const where = {};
  if (status) where.status = status;
  if (entity_type) where.entity_type = entity_type;
  const approvals = await db.findRows('approvals', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(approvals);
});

app.post('/api/approvals', requireAuth, async (req, res) => {
  const { entity_type, entity_id, reason } = req.body;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'Entity type and ID are required' });
  const now = new Date().toISOString();
  const approval = { id: uuidv4(), entity_type, entity_id, reason: reason || '', status: 'PENDING', requested_at: now, decided_at: null, decided_by: null, notes: '', created_at: now, updated_at: now };
  await db.insertRow('approvals', approval);
  await logActivity('Approval requested', 'Approval', approval.id, `Approval requested for ${entity_type} ${entity_id}`);
  await db.insertRow('notifications', { id: uuidv4(), user_id: null, type: 'approval', title: 'Approval Required', message: `${entity_type} requires approval: ${reason}`, entity_type: 'Approval', entity_id: approval.id, is_read: false, created_at: now });
  res.json({ success: true, approval });
});

app.put('/api/approvals/:id', requireAuth, async (req, res) => {
  const approval = await db.findRow('approvals', req.params.id);
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  if (approval.status !== 'PENDING') return res.status(400).json({ error: 'Approval already decided' });
  const { status, notes } = req.body;
  if (!['APPROVED','REJECTED'].includes(status)) return res.status(400).json({ error: 'Status must be APPROVED or REJECTED' });
  const updated = await db.updateRow('approvals', req.params.id, { status, notes: notes || '', decided_at: new Date().toISOString(), decided_by: req.session.userId, updated_at: new Date().toISOString() });
  await logActivity(`Approval ${status.toLowerCase()}`, 'Approval', approval.id, `${approval.entity_type} ${approval.entity_id} ${status.toLowerCase()}`);
  res.json({ success: true, approval: updated });
});

// =========================================================================
// PAYMENTS (Checkpoint 21)
// =========================================================================
app.get('/api/payments', requireAuth, async (req, res) => {
  const { deal_id, project_id, status } = req.query;
  const where = {};
  if (deal_id) where.deal_id = deal_id;
  if (project_id) where.project_id = project_id;
  if (status) where.status = status;
  const payments = await db.findRows('payments', Object.keys(where).length ? where : null, 'created_at DESC');
  res.json(payments);
});

app.post('/api/payments', requireAuth, async (req, res) => {
  const { deal_id, project_id, lead_id, total, advance, balance, reference, notes } = req.body;
  if (!total && total !== 0) return res.status(400).json({ error: 'Total amount is required' });
  const now = new Date().toISOString();
  const totalAmt = Number(total);
  const advanceAmt = Number(advance || 0);
  const balanceAmt = balance != null ? Number(balance) : totalAmt - advanceAmt;
  let status = 'NOT_REQUESTED';
  if (advanceAmt > 0 && advanceAmt >= totalAmt) status = 'PAID';
  else if (advanceAmt > 0) status = 'PARTIALLY_PAID';
  else status = 'ADVANCE_PENDING';
  
  const payment = { id: uuidv4(), deal_id: deal_id || null, project_id: project_id || null, lead_id: lead_id || null, total: totalAmt, advance: advanceAmt, balance: balanceAmt, advance_date: advanceAmt > 0 ? now : null, balance_date: null, reference: reference || '', status, notes: notes || '', metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('payments', payment);
  await logActivity('Payment created', 'Payment', payment.id, `Payment tracked: $${totalAmt} (advance: $${advanceAmt})`);
  if (status === 'ADVANCE_PENDING' || status === 'PARTIALLY_PAID') {
    await db.insertRow('notifications', { id: uuidv4(), user_id: null, type: 'payment_due', title: 'Payment Due', message: `Balance of $${balanceAmt} pending`, entity_type: 'Payment', entity_id: payment.id, is_read: false, created_at: now });
  }
  res.json({ success: true, payment });
});

app.put('/api/payments/:id', requireAuth, async (req, res) => {
  const payment = await db.findRow('payments', req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;
  if (updates.advance != null) updates.advance = Number(updates.advance);
  if (updates.balance != null) updates.balance = Number(updates.balance);
  if (updates.total != null) updates.total = Number(updates.total);
  if (updates.advance != null && updates.advance > 0) updates.advance_date = updates.advance_date || new Date().toISOString();
  if (updates.status === 'PAID') updates.balance_date = new Date().toISOString();
  const updated = await db.updateRow('payments', req.params.id, updates);
  await logActivity('Payment updated', 'Payment', payment.id, `Payment status: ${updates.status || payment.status}`);
  res.json({ success: true, payment: updated });
});

// =========================================================================
// DOMAIN & HOSTING (Checkpoint 22)
// =========================================================================
app.get('/api/domain-hosting', requireAuth, async (req, res) => {
  const { project_id } = req.query;
  const where = project_id ? { project_id } : null;
  const records = await db.findRows('domain_hosting', where, 'created_at DESC');
  res.json(records);
});

app.post('/api/domain-hosting', requireAuth, async (req, res) => {
  const { project_id, domain_required = true, domain_name, domain_owner, domain_cost_responsibility = 'client', registrar, domain_purchase_status = 'NOT_STARTED', domain_expiry, hosting_provider, hosting_plan, deployment_url, renewal_date } = req.body;
  if (!project_id) return res.status(400).json({ error: 'Project ID is required' });
  const now = new Date().toISOString();
  const record = { id: uuidv4(), project_id, domain_required, domain_name: domain_name || '', domain_owner: domain_owner || '', domain_cost_responsibility, registrar: registrar || '', domain_purchase_status, domain_expiry: domain_expiry || null, hosting_provider: hosting_provider || '', hosting_plan: hosting_plan || '', deployment_url: deployment_url || '', renewal_date: renewal_date || null, metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('domain_hosting', record);
  await logActivity('Domain/hosting created', 'DomainHosting', record.id, `Domain/hosting record for project ${project_id}`);
  res.json({ success: true, record });
});

app.put('/api/domain-hosting/:id', requireAuth, async (req, res) => {
  const rec = await db.findRow('domain_hosting', req.params.id);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.project_id; delete updates.created_at;
  const updated = await db.updateRow('domain_hosting', req.params.id, updates);
  res.json({ success: true, record: updated });
});

// Delivery checklist
app.post('/api/projects/:id/deliver', requireAuth, async (req, res) => {
  const project = await db.findRow('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Verify delivery conditions
  const issues = [];
  if (!project.production_url) issues.push('No production URL set');
  const domainRecords = await db.findRows('domain_hosting', { project_id: req.params.id });
  if (domainRecords.length === 0) issues.push('No domain/hosting record');
  const pendingRevisions = await db.findRows('revisions', { project_id: req.params.id });
  const unresolvedRevisions = pendingRevisions.filter(r => !['COMPLETED','APPROVED'].includes(r.status));
  if (unresolvedRevisions.length > 0) issues.push(`${unresolvedRevisions.length} unresolved revision(s)`);
  const payments = await db.findRows('payments', { project_id: req.params.id });
  const unpaid = payments.filter(p => p.status !== 'PAID');
  if (unpaid.length > 0) issues.push('Unpaid balance remaining');
  
  if (issues.length > 0 && !req.body.force) {
    return res.status(400).json({ error: 'Delivery conditions not met', issues });
  }
  
  const now = new Date().toISOString();
  await db.updateRow('projects', req.params.id, { status: 'DELIVERED', updated_at: now });
  if (project.lead_id) {
    await db.updateRow('leads', project.lead_id, { stage: 'DELIVERED', updated_at: now });
    await db.insertRow('lead_stage_history', { id: uuidv4(), lead_id: project.lead_id, stage: 'DELIVERED', changed_at: now, created_at: now });
  }
  await logActivity('Project delivered', 'Project', req.params.id, `Project ${project.name} delivered`);
  res.json({ success: true, issues_overridden: issues });
});

// =========================================================================
// MAINTENANCE PLANS (Checkpoint 22)
// =========================================================================
app.get('/api/maintenance-plans', requireAuth, async (req, res) => {
  const { project_id } = req.query;
  const where = project_id ? { project_id } : null;
  const plans = await db.findRows('maintenance_plans', where, 'created_at DESC');
  res.json(plans);
});

app.post('/api/maintenance-plans', requireAuth, async (req, res) => {
  const { project_id, lead_id, plan_name, description, monthly_cost, annual_cost, includes, start_date, renewal_date } = req.body;
  if (!project_id) return res.status(400).json({ error: 'Project ID is required' });
  const now = new Date().toISOString();
  const plan = { id: uuidv4(), project_id, lead_id: lead_id || null, plan_name: plan_name || 'Basic Maintenance', description: description || '', monthly_cost: Number(monthly_cost || 0), annual_cost: Number(annual_cost || 0), includes: includes || [], status: 'ACTIVE', start_date: start_date || now, renewal_date: renewal_date || null, metadata: {}, created_at: now, updated_at: now };
  await db.insertRow('maintenance_plans', plan);
  if (renewal_date) {
    await db.insertRow('notifications', { id: uuidv4(), user_id: null, type: 'maintenance_renewal', title: 'Maintenance Renewal', message: `Maintenance renewal for project ${project_id} on ${renewal_date}`, entity_type: 'MaintenancePlan', entity_id: plan.id, is_read: false, created_at: now });
  }
  await logActivity('Maintenance plan created', 'MaintenancePlan', plan.id, `Maintenance plan: ${plan.plan_name}`);
  res.json({ success: true, plan });
});

app.put('/api/maintenance-plans/:id', requireAuth, async (req, res) => {
  const plan = await db.findRow('maintenance_plans', req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;
  const updated = await db.updateRow('maintenance_plans', req.params.id, updates);
  res.json({ success: true, plan: updated });
});

// =========================================================================
// NOTIFICATIONS (Checkpoint 24)
// =========================================================================
app.get('/api/notifications', requireAuth, async (req, res) => {
  const { is_read, limit = 50 } = req.query;
  const where = {};
  if (is_read !== undefined) where.is_read = is_read === 'true';
  const notifications = await db.findRows('notifications', Object.keys(where).length ? where : null, 'created_at DESC', Number(limit));
  res.json(notifications);
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  const updated = await db.updateRow('notifications', req.params.id, { is_read: true, updated_at: new Date().toISOString() });
  if (!updated) return res.status(404).json({ error: 'Notification not found' });
  res.json({ success: true });
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  const unread = await db.findRows('notifications', { is_read: false });
  for (const n of unread) {
    await db.updateRow('notifications', n.id, { is_read: true, updated_at: new Date().toISOString() });
  }
  res.json({ success: true, count: unread.length });
});

// =========================================================================
// REPORTS & ANALYTICS (Checkpoint 25)
// =========================================================================
app.get('/api/reports/summary', requireAuth, async (req, res) => {
  const { from, to, period } = req.query;
  await reloadStore();
  const leads = store.leads || [];
  const logs = store.activity_logs || [];
  
  let fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  let toDate = to ? new Date(to) : new Date();
  
  const filteredLeads = leads.filter(l => { const d = new Date(l.created_at); return d >= fromDate && d <= toDate; });
  const filteredLogs = logs.filter(l => { const d = new Date(l.created_at); return d >= fromDate && d <= toDate; });
  
  const deals = await db.findRows('deals');
  const payments = await db.findRows('payments');
  const filteredDeals = deals.filter(d => { const dt = new Date(d.created_at); return dt >= fromDate && dt <= toDate; });
  
  const report = {
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    leads: { total: filteredLeads.length, new: filteredLeads.filter(l => l.stage === 'NEW').length, qualified: filteredLeads.filter(l => l.stage === 'QUALIFIED').length },
    contacts: filteredLogs.filter(l => l.action === 'Outreach sent').length,
    replies: filteredLogs.filter(l => l.action === 'Reply received').length,
    interested: filteredLeads.filter(l => ['INTERESTED','REQUIREMENT_COLLECTION','MEETING_REQUIRED','MEETING_SCHEDULED','NEGOTIATION','WON'].includes(l.stage)).length,
    meetings: filteredLogs.filter(l => l.action === 'Meeting created').length,
    deals: { won: filteredDeals.filter(d => d.status === 'WON').length, lost: filteredDeals.filter(d => d.status === 'LOST').length, open: filteredDeals.filter(d => d.status === 'OPEN').length },
    conversion_rate: filteredLeads.length > 0 ? Math.round(filteredDeals.filter(d => d.status === 'WON').length / filteredLeads.length * 100) : 0,
    revenue: payments.filter(p => p.status === 'PAID').reduce((s, p) => s + Number(p.total || 0), 0),
    pipeline_value: deals.filter(d => d.status === 'OPEN').reduce((s, d) => s + Number(d.offered_price || 0), 0),
    best_category: (() => { const cats = {}; filteredLeads.forEach(l => { if (l.category) cats[l.category] = (cats[l.category] || 0) + 1; }); return Object.entries(cats).sort((a,b) => b[1]-a[1])[0]?.[0] || 'N/A'; })(),
    best_location: (() => { const locs = {}; filteredLeads.forEach(l => { if (l.location) locs[l.location] = (locs[l.location] || 0) + 1; }); return Object.entries(locs).sort((a,b) => b[1]-a[1])[0]?.[0] || 'N/A'; })(),
  };
  res.json(report);
});

// =========================================================================
// AI SALES ASSISTANT (Gemini) - Endpoints
// =========================================================================
app.post('/api/ai/test-connection', requireAuth, async (req, res) => {
  const { gemini_api_key } = req.body;
  if (!gemini_api_key) return res.status(400).json({ success: false, error: 'API key is required' });
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${gemini_api_key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello" }] }]
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ success: false, error: `API error: ${errText}` });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper validation middleware for AI endpoints
const validateAiLead = async (req, res, next) => {
  const { lead_id } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'Lead ID is required' });
  try {
    const lead = await db.findRow('leads', lead_id);
    if (!lead) return res.status(404).json({ error: `Lead with ID ${lead_id} not found` });
    req.lead = lead;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/ai/email', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateEmail(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/whatsapp', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateWhatsApp(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/call-script', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateCallScript(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/followup', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateFollowUp(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/lead-score', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateLeadScore(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/business-summary', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateBusinessSummary(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/website-audit', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateWebsiteAudit(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/sales-pitch', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateSalesPitch(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/proposal', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateProposal(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/meeting-prep', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateMeetingPrep(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/objection-reply', requireAuth, validateAiLead, async (req, res) => {
  const { objection } = req.body;
  if (!objection) return res.status(400).json({ error: 'objection text is required' });
  try {
    const data = await aiService.generateObjectionReply(req.body.lead_id, objection, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/reply', requireAuth, validateAiLead, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message text is required' });
  try {
    const data = await aiService.generateReply(req.body.lead_id, message, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/tags', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateTags(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/next-action', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateNextAction(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/closing-probability', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateClosingProbability(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/seo', requireAuth, validateAiLead, async (req, res) => {
  try {
    const data = await aiService.generateSEO(req.body.lead_id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GMAIL INTEGRATION (Checkpoint 11) — Provider interface
// =========================================================================
app.get('/api/gmail/status', requireAuth, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({ connected: false, reason: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not configured in .env' });
  }
  const tokens = await db.findRows('oauth_tokens', { provider: 'gmail' });
  res.json({ connected: tokens.length > 0, credentials_configured: true, has_tokens: tokens.length > 0 });
});

app.get('/api/gmail/auth-url', requireAuth, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(501).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const redirectUri = `http://localhost:${PORT}/api/gmail/callback`;
  const scopes = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&access_type=offline&prompt=consent`;
  res.json({ auth_url: url });
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code missing');
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `http://localhost:${PORT}/api/gmail/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await response.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);
    await db.insertRow('oauth_tokens', { id: uuidv4(), user_id: req.session?.userId || 'owner', provider: 'gmail', access_token: tokens.access_token, refresh_token: tokens.refresh_token || '', token_type: tokens.token_type, expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), scope: tokens.scope || '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    res.send('<html><body><h2>Gmail connected successfully!</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  } catch (err) {
    res.status(500).send('OAuth callback failed: ' + err.message);
  }
});

function decodeBase64(data) {
  if (!data) return '';
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function getGmailMessageBody(payload) {
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    let htmlBody = '';
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlBody = decodeBase64(part.body.data);
      }
      if (part.parts) {
        const body = getGmailMessageBody(part);
        if (body) return body;
      }
    }
    if (htmlBody) return htmlBody;
  }
  return '';
}

app.post('/api/gmail/sync', requireAuth, async (req, res) => {
  try {
    const accessToken = await getValidGmailToken();
    if (!accessToken) {
      return res.status(400).json({ error: 'Gmail not connected. Please connect Gmail under Meetings/OAuth.' });
    }

    // Get user's own email address to filter out sent emails
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let userEmail = '';
    if (profileRes.ok) {
      const profile = await profileRes.json();
      userEmail = profile.emailAddress ? profile.emailAddress.toLowerCase().trim() : '';
    }

    // 1. Fetch all outreach messages that are SENT to extract their thread_id
    const sentMessages = await db.findRows('outreach_messages', { status: 'SENT' });
    const activeThreads = new Map(); // thread_id -> lead_id
    for (const msg of sentMessages) {
      if (msg.metadata) {
        try {
          const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
          if (meta && meta.thread_id) {
            activeThreads.set(meta.thread_id, msg.lead_id);
          }
        } catch (e) {
          // ignore parsing error
        }
      }
    }

    // 2. Fetch all leads to map their email addresses to lead_id
    const leads = await db.findRows('leads');
    const leadEmails = new Map(); // email -> lead_id
    for (const lead of leads) {
      if (lead.public_email) {
        leadEmails.set(lead.public_email.toLowerCase().trim(), lead.id);
      }
    }

    // 3. Fetch recent messages from Gmail
    const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100';
    const listRes = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Gmail API messages list failed: ${errText}`);
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];

    let syncedCount = 0;

    // Helper to extract email from From header value (e.g. "Name <email@domain.com>")
    const extractEmailFromHeader = (fromVal) => {
      if (!fromVal) return '';
      const match = fromVal.match(/<([^>]+)>/);
      if (match) return match[1].toLowerCase().trim();
      return fromVal.toLowerCase().trim();
    };

    // 4. For each message, check if it belongs to a lead
    for (const msgSummary of messages) {
      // Check if we already imported this message
      const existing = await db.findRows('conversations', { external_id: msgSummary.id });
      if (existing.length > 0) {
        continue; // Already synced
      }

      // Fetch detailed message content
      const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgSummary.id}`;
      const detailRes = await fetch(detailUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!detailRes.ok) {
        console.error(`[server] Failed to fetch message detail for ${msgSummary.id}:`, await detailRes.text());
        continue;
      }

      const msgDetail = await detailRes.json();
      
      // Extract headers
      const headers = msgDetail.payload.headers || [];
      const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
      
      const subject = subjectHeader ? subjectHeader.value : 'No Subject';
      const from = fromHeader ? fromHeader.value : '';
      const senderEmail = extractEmailFromHeader(from);

      // Skip if the message was sent by the user themselves
      if (userEmail && senderEmail === userEmail) {
        continue;
      }

      // Determine which lead this message belongs to
      let leadId = null;
      const threadId = msgSummary.threadId;

      if (activeThreads.has(threadId)) {
        leadId = activeThreads.get(threadId);
      } else if (senderEmail && leadEmails.has(senderEmail)) {
        leadId = leadEmails.get(senderEmail);
      }

      // If it belongs to a valid lead, import it!
      if (leadId) {
        const body = getGmailMessageBody(msgDetail.payload);
        const now = new Date().toISOString();
        const convo = {
          id: uuidv4(),
          lead_id: leadId,
          contact_id: null,
          direction: 'inbound',
          channel: 'email',
          subject,
          body: body || msgDetail.snippet || 'No body content',
          external_id: msgSummary.id,
          thread_id: threadId,
          metadata: JSON.stringify({ from, labelIds: msgDetail.labelIds }),
          created_at: msgDetail.internalDate ? new Date(Number(msgDetail.internalDate)).toISOString() : now
        };

        await db.insertRow('conversations', convo);
        await logActivity('Reply received (Synced)', 'Conversation', convo.id, `Real email reply synced from ${from} for lead ${leadId}`);
        
        syncedCount++;
      }
    }
    // 5. Flag leads with no reply after 7 days as "FOLLOW_UP"
    try {
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      const contactedLeads = await db.findRows('leads', { stage: 'CONTACTED' });
      for (const contactedLead of contactedLeads) {
        if (contactedLead.last_contact_date && new Date(contactedLead.last_contact_date) < oneWeekAgo) {
          const stageHistory = contactedLead.stage_history || [];
          stageHistory.unshift({ stage: 'FOLLOW_UP', changed_at: new Date().toISOString() });
          await db.updateRow('leads', contactedLead.id, {
            stage: 'FOLLOW_UP',
            stage_history: stageHistory,
            updated_at: new Date().toISOString()
          });
          await logActivity('Follow-up due', 'Lead', contactedLead.id, `Lead ${contactedLead.business_name} has not replied in 7 days. Flagged for follow-up.`);
        }
      }
    } catch (e) {
      console.error('[server] Stale leads follow-up check failed:', e.message);
    }

    res.json({ success: true, synced: syncedCount, message: `Successfully synced ${syncedCount} new replies.` });
  } catch (err) {
    console.error('[server] Gmail sync failed:', err.message);
    res.status(500).json({ error: `Gmail sync failed: ${err.message}` });
  }
});


// =========================================================================
// GOOGLE CALENDAR (Checkpoint 15) — Provider interface
// =========================================================================
app.get('/api/calendar/status', requireAuth, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.json({ connected: false, reason: 'GOOGLE_CLIENT_ID not configured' });
  const tokens = await db.findRows('oauth_tokens', { provider: 'google_calendar' });
  res.json({ connected: tokens.length > 0, credentials_configured: Boolean(clientId) });
});

app.get('/api/calendar/auth-url', requireAuth, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(501).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const redirectUri = `http://localhost:${PORT}/api/calendar/callback`;
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&access_type=offline&prompt=consent`;
  res.json({ auth_url: url });
});

app.get('/api/calendar/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code missing');
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `http://localhost:${PORT}/api/calendar/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await response.json();
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);
    await db.insertRow('oauth_tokens', { id: uuidv4(), user_id: req.session?.userId || 'owner', provider: 'google_calendar', access_token: tokens.access_token, refresh_token: tokens.refresh_token || '', token_type: tokens.token_type, expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), scope: tokens.scope || '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    res.send('<html><body><h2>Google Calendar connected!</h2><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  } catch (err) {
    res.status(500).send('OAuth callback failed: ' + err.message);
  }
});

// =========================================================================
// GITHUB & RENDER STATUS (Checkpoint 23)
// =========================================================================
app.get('/api/integrations/status', requireAuth, async (req, res) => {
  const gmailTokens = await db.findRows('oauth_tokens', { provider: 'gmail' });
  const calendarTokens = await db.findRows('oauth_tokens', { provider: 'google_calendar' });
  res.json({
    supabase: { status: db.isPostgres ? 'CONNECTED' : 'NOT_CONFIGURED', type: 'INTEGRATED' },
    google_maps: { status: process.env.GOOGLE_MAPS_DEMO_KEY ? 'CONFIGURED' : 'NOT_CONFIGURED', type: 'INTEGRATED' },
    gmail: { status: gmailTokens.length > 0 ? 'CONNECTED' : (process.env.GOOGLE_CLIENT_ID ? 'CREDENTIALS_READY' : 'NOT_CONFIGURED'), type: 'INTEGRATED' },
    google_calendar: { status: calendarTokens.length > 0 ? 'CONNECTED' : (process.env.GOOGLE_CLIENT_ID ? 'CREDENTIALS_READY' : 'NOT_CONFIGURED'), type: 'INTEGRATED' },
    github: { status: 'EXTERNALLY_CONNECTED', type: 'MANUAL_WORKFLOW', note: 'Use GitHub directly. WebCloserAI does not have GitHub API access in beta.' },
    render: { status: 'EXTERNALLY_CONNECTED', type: 'MANUAL_WORKFLOW', note: 'Deploy via Render dashboard. WebCloserAI does not have Render API access in beta.' }
  });
});

const METRICS_FILE = path.join(__dirname, 'data', 'campaign_metrics.json');
async function incrementCampaignMetric(query, location, field, increment = 1, reason = '') {
  try {
    const key = `${query}_in_${location}`.toLowerCase().replace(/\s+/g, '_');
    let metrics = {};
    if (fs.existsSync(METRICS_FILE)) {
      metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
    }
    if (!metrics[key]) {
      metrics[key] = { query, location, sent: 0, delivered: 0, bounced: 0, open: 0, replied: 0, failed: 0, failed_reasons: [] };
    }
    metrics[key][field] = (metrics[key][field] || 0) + increment;
    if (reason) {
      if (!metrics[key].failed_reasons) metrics[key].failed_reasons = [];
      metrics[key].failed_reasons.push(reason);
    }
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), 'utf-8');
  } catch (e) {
    console.error('[server] Failed to increment campaign metric:', e.message);
  }
}

app.get('/api/campaign-metrics', requireAuth, (req, res) => {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      return res.json(JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8')));
    }
  } catch (e) {}
  res.json({});
});

// =========================================================================
// CATCH-ALL ROUTES
// =========================================================================
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found' });
  if (req.session && req.session.userId) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// =========================================================================
// STARTUP
// =========================================================================
async function startServer() {
  try {
    if (db.isPostgres) {
      await db.ensureSchema();
      console.log('[server] PostgreSQL schema ready');
    }
    await ensureDefaults();
    console.log('[server] Defaults initialized');
  } catch (err) {
    console.error('[server] Startup error:', err.message);
  }
}

startServer();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Jarvis agency platform running on http://localhost:${PORT}`);
  });
}

module.exports = { app, getDashboardStats, ensureDefaults, calculateLeadScore, parseScoringRules, isDuplicateLead, loadDb: reloadStore, db: store };
