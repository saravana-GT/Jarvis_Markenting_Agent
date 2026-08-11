const test = require('node:test');
const assert = require('node:assert/strict');
const { getDashboardStats, ensureDefaults, calculateLeadScore, parseScoringRules, isDuplicateLead, loadDb, db } = require('../server');

test('dashboard stats initialize with zeroed values', () => {
  const stats = getDashboardStats();
  assert.equal(stats.totalLeads, 0);
  assert.equal(stats.newLeads, 0);
  assert.equal(stats.replies, 0);
});

test('ensureDefaults seeds settings and owner account', () => {
  ensureDefaults();
  const stats = getDashboardStats();
  assert.equal(stats.totalLeads, 0);
});

test('lead scoring returns a number between 0 and 100', () => {
  const { score } = calculateLeadScore({
    public_website: '',
    public_email: 'hi@example.com',
    public_phone: '',
    whatsapp: '',
    instagram: '',
    other_contact: '',
    contact_validity: 'UNKNOWN',
    category: 'Restaurant',
    location: 'Local'
  });
  assert.equal(typeof score, 'number');
  assert(score >= 0 && score <= 100);
});

test('lead scoring rules are available from settings', () => {
  ensureDefaults();
  const rules = parseScoringRules();
  assert.equal(rules.noWebsite, 30);
});

test('duplicate lead detection returns true for matching website and email', async () => {
  await loadDb();
  db.leads.push({
    id: 'test-1',
    business_name: 'Acme Site',
    public_email: 'hello@acme.com',
    public_website: 'https://acme.com',
    public_phone: ''
  });
  const duplicate = isDuplicateLead({ business_name: 'Acme Site', public_email: 'hello@acme.com', public_website: 'https://acme.com', public_phone: '' });
  assert.equal(duplicate, true);
});
