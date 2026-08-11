const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

test('database module runs CRUD operations successfully', async () => {
  // 1. Initialise schema/store
  await db.ensureSchema();

  const testId = 'TEST_' + uuidv4();
  const testLead = {
    id: testId,
    business_name: 'TEST_Db_CRUD_Business',
    category: 'TEST_Category',
    location: 'TEST_Location',
    public_website: 'https://testcrud.com',
    public_email: 'testcrud@example.com',
    public_phone: '1234567890',
    whatsapp: '1234567890',
    instagram: '@testcrud',
    other_contact: '',
    preferred_contact_method: 'Email',
    contact_validity: 'UNKNOWN',
    last_contact_date: '',
    next_follow_up_date: '',
    opt_out: false,
    source: 'TEST_Source',
    discovery_date: new Date().toISOString(),
    stage: 'NEW',
    score: 50,
    priority: 'MEDIUM',
    qualification_reason: 'TEST_Reason',
    status: 'ACTIVE',
    stage_history: [],
    website_analysis: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // 2. CREATE
  const inserted = await db.insertRow('leads', testLead);
  assert.equal(inserted.id, testId);
  assert.equal(inserted.business_name, 'TEST_Db_CRUD_Business');

  // 3. READ
  const retrieved = await db.findRow('leads', testId);
  assert.ok(retrieved);
  assert.equal(retrieved.business_name, 'TEST_Db_CRUD_Business');

  // 4. UPDATE
  const updated = await db.updateRow('leads', testId, {
    business_name: 'TEST_Db_CRUD_Business_Updated',
    score: 75
  });
  assert.ok(updated);
  assert.equal(updated.business_name, 'TEST_Db_CRUD_Business_Updated');
  assert.equal(updated.score, 75);

  // Verify retrieval of updated
  const retrievedUpdated = await db.findRow('leads', testId);
  assert.equal(retrievedUpdated.business_name, 'TEST_Db_CRUD_Business_Updated');

  // 5. DELETE
  const deleted = await db.deleteRow('leads', testId);
  assert.ok(deleted);

  // Verify deletion
  const retrievedDeleted = await db.findRow('leads', testId);
  assert.equal(retrievedDeleted, null);
});
