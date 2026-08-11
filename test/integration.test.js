const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

test('complete end-to-end workflow verification', async () => {
  await db.ensureSchema();

  const testSuffix = uuidv4().substring(0, 8);
  const leadId = 'TEST_LEAD_' + testSuffix;
  const contactId = 'TEST_CONTACT_' + testSuffix;
  const templateId = 'TEST_TEMPLATE_' + testSuffix;
  const messageId = 'TEST_MSG_' + testSuffix;
  const followUpId = 'TEST_FU_' + testSuffix;
  const convoId = 'TEST_CONVO_' + testSuffix;
  const reqId = 'TEST_REQ_' + testSuffix;
  const meetingId = 'TEST_MEET_' + testSuffix;
  const briefId = 'TEST_BRIEF_' + testSuffix;
  const projectId = 'TEST_PROJ_' + testSuffix;
  const taskId = 'TEST_TASK_' + testSuffix;
  const demoId = 'TEST_DEMO_' + testSuffix;
  const feedbackId = 'TEST_FB_' + testSuffix;
  const revisionId = 'TEST_REV_' + testSuffix;
  const quoteId = 'TEST_QUOTE_' + testSuffix;
  const dealId = 'TEST_DEAL_' + testSuffix;
  const approvalId = 'TEST_APP_' + testSuffix;
  const paymentId = 'TEST_PAY_' + testSuffix;
  const domainId = 'TEST_DOM_' + testSuffix;
  const maintId = 'TEST_MAINT_' + testSuffix;

  // Cleanup helper
  const cleanUp = async () => {
    await db.deleteRow('maintenance_plans', maintId);
    await db.deleteRow('domain_hosting', domainId);
    await db.deleteRow('payments', paymentId);
    await db.deleteRow('approvals', approvalId);
    await db.deleteRow('deals', dealId);
    await db.deleteRow('quotation_items', quoteId); // Cascade or manual
    await db.deleteRow('quotations', quoteId);
    await db.deleteRow('revisions', revisionId);
    await db.deleteRow('feedback', feedbackId);
    await db.deleteRow('demos', demoId);
    await db.deleteRow('project_tasks', taskId);
    await db.deleteRow('projects', projectId);
    await db.deleteRow('client_briefs', briefId);
    await db.deleteRow('meetings', meetingId);
    await db.deleteRow('requirements', reqId);
    await db.deleteRow('conversations', convoId);
    await db.deleteRow('follow_ups', followUpId);
    await db.deleteRow('outreach_messages', messageId);
    await db.deleteRow('outreach_templates', templateId);
    await db.deleteRow('contacts', contactId);
    await db.deleteRow('leads', leadId);
  };

  try {
    // 1. Lead Created
    const lead = await db.insertRow('leads', {
      id: leadId,
      business_name: 'TEST_' + testSuffix + '_Corp',
      category: 'Restaurants',
      location: 'Local NYC',
      public_website: 'http://testnyc.com',
      public_email: 'nyc@testnyc.com',
      public_phone: '555-1111',
      stage: 'NEW',
      score: 10,
      priority: 'LOW',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(lead.id, leadId);
    assert.equal(lead.stage, 'NEW');

    // Create a contact
    const contact = await db.insertRow('contacts', {
      id: contactId,
      lead_id: leadId,
      full_name: 'Jane Doe',
      email: 'jane@testnyc.com',
      is_primary: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(contact.id, contactId);

    // 2. Website Analyzed (simulate)
    const mockAnalysis = {
      website_exists: true,
      accessible: true,
      https_available: false,
      mobile_friendly: true,
      contact_present: true,
      booking_ordering_present: false,
      improvement_opportunity: 'Missing HTTPS and ordering functionality'
    };
    const leadAnalyzed = await db.updateRow('leads', leadId, {
      stage: 'ANALYZED',
      website_analysis: mockAnalysis,
      updated_at: new Date().toISOString()
    });
    assert.equal(leadAnalyzed.stage, 'ANALYZED');
    assert.ok(leadAnalyzed.website_analysis.accessible);

    // 3. Scored (re-score based on analysis rules)
    // Restaurant category (+10), Local location (+10), Website exists (+0 no website penalty avoided)
    const newScore = 60; // Mock score
    const leadScored = await db.updateRow('leads', leadId, {
      score: newScore,
      priority: 'MEDIUM',
      updated_at: new Date().toISOString()
    });
    assert.equal(leadScored.score, 60);
    assert.equal(leadScored.priority, 'MEDIUM');

    // 4. Qualified
    const leadQualified = await db.updateRow('leads', leadId, {
      stage: 'QUALIFIED',
      qualification_reason: 'NYC Restaurant with high score',
      updated_at: new Date().toISOString()
    });
    assert.equal(leadQualified.stage, 'QUALIFIED');

    // 5. Outreach Template & Drafted
    const template = await db.insertRow('outreach_templates', {
      id: templateId,
      name: 'Cold Intro NY',
      subject: 'Boost your online orders',
      body: 'Hi {contact_name}, we can help {business_name}...',
      channel: 'email',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(template.id, templateId);

    const message = await db.insertRow('outreach_messages', {
      id: messageId,
      lead_id: leadId,
      contact_id: contactId,
      template_id: templateId,
      channel: 'email',
      subject: 'Boost your online orders',
      body: 'Hi Jane Doe, we can help TEST_' + testSuffix + '_Corp...',
      status: 'DRAFT',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(message.status, 'DRAFT');

    // 6. Contacted Simulated (mark sent)
    const msgSent = await db.updateRow('outreach_messages', messageId, {
      status: 'SENT',
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(msgSent.status, 'SENT');

    // Update lead stage
    await db.updateRow('leads', leadId, { stage: 'CONTACTED', updated_at: new Date().toISOString() });

    // 7. Follow-up Scheduled
    const followUp = await db.insertRow('follow_ups', {
      id: followUpId,
      lead_id: leadId,
      sequence_number: 1,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      status: 'PENDING',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(followUp.status, 'PENDING');

    // 8. Reply Simulated
    const reply = await db.insertRow('conversations', {
      id: convoId,
      lead_id: leadId,
      contact_id: contactId,
      direction: 'inbound',
      channel: 'email',
      subject: 'Re: Boost your online orders',
      body: 'I am interested, lets talk.',
      created_at: new Date().toISOString()
    });
    assert.equal(reply.direction, 'inbound');

    // Update lead stage to REPLIED
    await db.updateRow('leads', leadId, { stage: 'REPLIED', updated_at: new Date().toISOString() });

    // Cancel follow up since they replied
    await db.updateRow('follow_ups', followUpId, { status: 'CANCELLED', updated_at: new Date().toISOString() });
    const checkFU = await db.findRow('follow_ups', followUpId);
    assert.equal(checkFU.status, 'CANCELLED');

    // 9. Requirements Collected
    const requirements = await db.insertRow('requirements', {
      id: reqId,
      lead_id: leadId,
      business_details: 'Authentic Italian pizza shop',
      website_purpose: 'Online pizza orders and reservations',
      pages: ['Home', 'Menu', 'About', 'Contact'],
      features: ['Cart', 'Online checkout', 'Reservation calendar'],
      status: 'CONFIRMED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(requirements.status, 'CONFIRMED');

    // 10. Meeting Escalated (trigger meeting required)
    await db.updateRow('leads', leadId, { stage: 'MEETING_REQUIRED', updated_at: new Date().toISOString() });

    // 11. Meeting / Calendar Event Created
    const meeting = await db.insertRow('meetings', {
      id: meetingId,
      lead_id: leadId,
      contact_id: contactId,
      title: 'Discovery call - NY Italian Pizza',
      scheduled_at: new Date(Date.now() + 172800000).toISOString(),
      duration_minutes: 45,
      location: 'Google Meet',
      status: 'SCHEDULED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(meeting.status, 'SCHEDULED');
    await db.updateRow('leads', leadId, { stage: 'MEETING_SCHEDULED', updated_at: new Date().toISOString() });

    // 12. Client Brief Generated
    const brief = await db.insertRow('client_briefs', {
      id: briefId,
      lead_id: leadId,
      business_summary: 'TEST NY pizza shop needs ordering system',
      known_requirements: 'Reservation system + food menu ordering',
      budget: '$2500',
      deadline: '4 weeks',
      meeting_objective: 'Review page designs and finalize deal',
      status: 'GENERATED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(brief.status, 'GENERATED');

    // 13. Project Created
    const project = await db.insertRow('projects', {
      id: projectId,
      lead_id: leadId,
      name: 'TEST Pizza Delivery Web App',
      description: 'E-commerce website for NYC pizza branch',
      status: 'PLANNING',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(project.status, 'PLANNING');
    await db.updateRow('leads', leadId, { stage: 'PROJECT_ACTIVE', updated_at: new Date().toISOString() });

    // 14. Demo Added
    const demo = await db.insertRow('demos', {
      id: demoId,
      project_id: projectId,
      demo_url: 'http://demo.jarvis.agency/pizza-shop',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(demo.status, 'ACTIVE');

    // 15. Feedback Added
    const feedback = await db.insertRow('feedback', {
      id: feedbackId,
      demo_id: demoId,
      project_id: projectId,
      lead_id: leadId,
      rating: 4,
      comments: 'Looks good but change button color to red',
      status: 'SUBMITTED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(feedback.rating, 4);

    // 16. Revision Completed
    const revision = await db.insertRow('revisions', {
      id: revisionId,
      project_id: projectId,
      revision_number: 1,
      description: 'Change primary buttons to red',
      status: 'COMPLETED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(revision.status, 'COMPLETED');

    // 17. Quote Created (needs approval due to discount > 20%)
    const quote = await db.insertRow('quotations', {
      id: quoteId,
      lead_id: leadId,
      project_id: projectId,
      base_price: 2500,
      discount_percentage: 25,
      discount_amount: 625,
      final_price: 1875,
      advance_percentage: 50,
      advance_amount: 938,
      balance: 937,
      status: 'NEEDS_APPROVAL',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(quote.status, 'NEEDS_APPROVAL');

    // 18. Approval Processed
    const approval = await db.insertRow('approvals', {
      id: approvalId,
      entity_type: 'Quotation',
      entity_id: quoteId,
      reason: '25% discount override by Owner',
      status: 'APPROVED',
      requested_at: new Date().toISOString(),
      decided_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(approval.status, 'APPROVED');
    await db.updateRow('quotations', quoteId, { status: 'APPROVED', updated_at: new Date().toISOString() });

    // 19. Deal Won
    const deal = await db.insertRow('deals', {
      id: dealId,
      lead_id: leadId,
      quotation_id: quoteId,
      project_id: projectId,
      offered_price: 2500,
      final_price: 1875,
      status: 'WON',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(deal.status, 'WON');
    await db.updateRow('leads', leadId, { stage: 'WON', updated_at: new Date().toISOString() });

    // 20. Advance Recorded
    const payment = await db.insertRow('payments', {
      id: paymentId,
      deal_id: dealId,
      project_id: projectId,
      lead_id: leadId,
      total: 1875,
      advance: 938,
      balance: 937,
      status: 'PARTIALLY_PAID',
      advance_date: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(payment.status, 'PARTIALLY_PAID');

    // 21. Project Progressed (Tasks completed)
    const task = await db.insertRow('project_tasks', {
      id: taskId,
      project_id: projectId,
      title: 'Build Menu Page',
      status: 'DONE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(task.status, 'DONE');
    await db.updateRow('projects', projectId, { status: 'DEVELOPMENT', updated_at: new Date().toISOString() });

    // 22. Balance Recorded
    const paymentCompleted = await db.updateRow('payments', paymentId, {
      advance: 1875,
      balance: 0,
      status: 'PAID',
      balance_date: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(paymentCompleted.status, 'PAID');
    assert.equal(Number(paymentCompleted.balance), 0);

    // 23. Deployment Recorded
    const domainRecord = await db.insertRow('domain_hosting', {
      id: domainId,
      project_id: projectId,
      domain_name: 'testnyc.com',
      deployment_url: 'https://testnyc.com',
      domain_purchase_status: 'COMPLETED',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(domainRecord.domain_purchase_status, 'COMPLETED');
    await db.updateRow('projects', projectId, { status: 'READY_TO_DEPLOY', production_url: 'https://testnyc.com', updated_at: new Date().toISOString() });

    // 24. Delivered
    await db.updateRow('projects', projectId, { status: 'DELIVERED', updated_at: new Date().toISOString() });
    await db.updateRow('leads', leadId, { stage: 'DELIVERED', updated_at: new Date().toISOString() });
    
    const checkProj = await db.findRow('projects', projectId);
    const checkLead = await db.findRow('leads', leadId);
    assert.equal(checkProj.status, 'DELIVERED');
    assert.equal(checkLead.stage, 'DELIVERED');

    // 25. Maintenance Created
    const maintenance = await db.insertRow('maintenance_plans', {
      id: maintId,
      project_id: projectId,
      lead_id: leadId,
      plan_name: 'Pro Pizza Care',
      monthly_cost: 49,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(maintenance.status, 'ACTIVE');

    console.log('End-to-End Workflow Integration Test succeeded!');

  } finally {
    // 26. Cleanup temporary data
    await cleanUp();
    console.log('Temporary data cleaned up successfully.');
  }
});
