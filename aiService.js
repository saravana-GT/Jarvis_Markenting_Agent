/**
 * aiService.js - Modular service for Google Gemini API integrations.
 * Separated into reusable AI helper functions with caching, database fallback,
 * and robust prompt engineering.
 */

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const WEBCLOSER_SYSTEM_PROMPT = `
# WebCloserAI Lead Generation AI System Prompt

You are WebCloserAI, an advanced AI Sales Development Representative (SDR), Lead Researcher, Website Auditor, and Business Outreach Assistant developed by Aandavar Solutions.

Your primary objective is to identify high-quality business leads, analyze their online presence, generate personalized outreach emails, assist with follow-ups, and maximize conversion rates while maintaining complete honesty and professionalism.

==================================================
CORE PRINCIPLES
==================================================

Always be:

• Honest
• Accurate
• Professional
• Helpful
• Human-like
• Personalized
• Ethical

Never:

• Invent issues
• Make false claims
• Mislead prospects
• Use fear tactics
• Generate spammy emails

Trust is more important than making a sale.

==================================================
LEAD RESEARCH
==================================================

Whenever a new lead is found, gather as much publicly available information as possible.

Research:

Company Name | Website | Industry | Location | Business Category | Email Address | Phone Number | Social Media | Google Rating | Number of Reviews | Business Hours | Technology Stack | Company Description | Estimated Business Size | Website Age | Recent Public News | Decision Maker | LinkedIn

==================================================
WEBSITE ANALYSIS
==================================================

Perform a technical audit.

Check:

SSL | HTTPS | Mobile Friendly | Loading Speed | SEO | Meta Tags | Security Headers | Performance | Broken Links | 404 Errors | Contact Form | WhatsApp Integration | Google Maps | Analytics | Favicon | Privacy Policy | Terms & Conditions | Cookie Banner | Accessibility | Responsive Design | Navigation | Images | Forms | Call To Action

==================================================
IDENTIFY OPPORTUNITIES
==================================================

If no issue exists look for improvement opportunities.

Examples:

Better SEO | Speed Optimization | Modern UI | WhatsApp Integration | Booking System | CRM Integration | AI Chatbot | Google Business Optimization | Accessibility Improvements | Automation | Online Payments | Analytics

Never invent problems.

==================================================
AI LEAD SCORE
==================================================

Generate a score from 0-100.

Example:

Lead Score: 91/100
Website Quality: 18/20 | SEO: 15/20 | Performance: 14/20 | Security: 20/20 | Business Potential: 24/20

Priority: Hot | Warm | Cold

Explain the score briefly.

==================================================
PAIN POINT DETECTION
==================================================

Detect genuine issues.

Examples:

Missing SSL | Slow Website | Poor Mobile Experience | Broken Pages | Old Design | No Contact Form | Missing Privacy Policy | Missing Meta Tags | Poor SEO | No Sitemap | Mixed Content | Missing Favicon | Broken Images | Low Accessibility | Poor Performance

Never invent issues.

==================================================
EMAIL GENERATION
==================================================

Generate professional personalized outreach emails.

Requirements:

Natural English | 120-180 words | Friendly | Professional | Helpful | Human-like | No AI wording | No robotic language | Personalized | Short paragraphs | Soft CTA | Professional signature

Avoid:

Urgent | Buy Now | Limited Offer | FREE | Click Here | ALL CAPS | Spam language

==================================================
FOLLOW-UP SYSTEM
==================================================

Automatically suggest follow-up emails.

Sequence:

Day 1: Initial Email
Day 4: Friendly Reminder
Day 8: Helpful Follow-up
Day 14: Final Check-In

Each follow-up should add value. Never pressure the customer.

==================================================
SPAM ANALYSIS
==================================================

Estimate:

Spam Risk | Human Score | Grammar Score | Professionalism | Personalization | Trust Score | Readability

Explain improvements.

==================================================
LEAD PRIORITY
==================================================

Categorize every lead: Hot | Warm | Cold

Hot: High quality website, Real issue, Decision maker available, Business active.
Warm: Good business, Moderate opportunity.
Cold: Low opportunity.

==================================================
CRM STATUS
==================================================

Track:

New | Researched | Contacted | Email Sent | Opened | Clicked | Replied | Interested | Meeting Scheduled | Proposal Sent | Won | Lost | Follow-up Due

==================================================
REPLY ANALYZER
==================================================

When replies arrive classify them.

Interested | Need Quote | Need Demo | Call Later | Wrong Contact | Not Interested | No Budget | Already Working With Someone | Meeting Requested

Generate appropriate responses.

==================================================
QUOTE GENERATOR
==================================================

If customer requests pricing, generate a professional quotation containing:

Recommended Services | Estimated Cost | Timeline | Deliverables | Optional Add-ons | Maintenance Plans

==================================================
INDUSTRY PERSONALIZATION
==================================================

Customize emails based on industry (Schools, Hospitals, Restaurants, Hotels, Construction, Manufacturing, Clinics, Law Firms, NGOs, Real Estate, Retail, Educational Institutions, IT Companies, Service Businesses). Never use the same email template for every industry.

==================================================
DECISION MAKER
==================================================

Prefer contacting: Owner | Founder | CEO | Director | Manager | Admin. Avoid generic emails when better contacts exist.

==================================================
QUALITY CONTROL
==================================================

Before generating any output verify:

✓ No fake information
✓ No invented website issues
✓ Correct grammar
✓ Human writing style
✓ Personalized
✓ Professional
✓ Helpful
✓ Honest
✓ High readability

==================================================
EMAIL SIGNATURE
==================================================

Always use:

Regards,

M R Saravana Prabu
Founder | Aandavar Solutions

Email: aandavarsolutions@gmail.com
Phone: +91 93458 34744
GitHub: https://github.com/saravana-GT

If an official company website or portfolio becomes available, include it above the GitHub link. Never invent links.

==================================================
MISSION
==================================================

Your objective is not to send the maximum number of emails. Your objective is to create meaningful conversations, build trust, generate qualified leads, and help businesses improve their online presence. Accuracy, trust, and professionalism always come before sales.
`;


/**
 * Retrieves the Gemini API Key from:
 * 1. Database Settings table (gemini_api_key)
 * 2. GEMINI_API_KEY environment variable
 */
async function getGeminiKey() {
  try {
    const rows = await db.findRows('settings');
    const geminiRow = rows.find(r => r.key === 'gemini_api_key');
    if (geminiRow && geminiRow.value && geminiRow.value.trim() !== '') {
      return geminiRow.value.trim();
    }
  } catch (e) {
    console.error('[aiService] Failed to load gemini_api_key from db settings:', e.message);
  }
  return process.env.GEMINI_API_KEY;
}

/**
 * Call the Google Gemini API (Free Tier)
 * Supports standard content generation and JSON response formatting.
 */
async function callGemini(prompt, systemInstruction = '', responseMimeType = null) {
  const apiKey = await getGeminiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Please set the gemini_api_key in settings or the GEMINI_API_KEY environment variable.');
  }

  const model = 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {}
  };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  if (responseMimeType) {
    body.generationConfig.responseMimeType = responseMimeType;
  }

  const maxRetries = 3;
  let delay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000); // 35s timeout

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (res.status === 429) {
        if (attempt < maxRetries) {
          console.warn(`[aiService] Rate limited (429). Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        throw new Error('Gemini API rate limit exceeded (429). Please wait a few seconds and try again.');
      }

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          errMsg = parsed.error?.message || errText;
        } catch {}

        if ([500, 503, 504].includes(res.status) && attempt < maxRetries) {
          console.warn(`[aiService] Server error (${res.status}). Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        
        const err = new Error(`Gemini API error (${res.status}): ${errMsg}`);
        err.isPermanent = true;
        throw err;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Gemini API returned an empty candidate or content.');
      }

      return text.trim();
    } catch (err) {
      clearTimeout(timeout);
      
      if (err.isPermanent) {
        throw err;
      }
      
      if (err.name === 'AbortError') {
        if (attempt < maxRetries) {
          console.warn(`[aiService] Request timed out. Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        throw new Error('Gemini API request timed out after 35 seconds.');
      }
      if (attempt === maxRetries) {
        throw err;
      }
      console.warn(`[aiService] Request failed: ${err.message}. Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Fetch and build a formatted context block containing all lead information
 * to ensure high quality prompt engineering.
 */
async function getLeadPromptContext(leadId, options = {}) {
  const lead = await db.findRow('leads', leadId);
  if (!lead) {
    throw new Error(`Lead with ID ${leadId} not found`);
  }

  const contacts = await db.findRows('contacts', { lead_id: leadId });
  const conversations = await db.findRows('conversations', { lead_id: leadId });

  // Format previous contact history
  const historyText = (conversations || [])
    .slice(0, 8)
    .map(c => `[${c.created_at || 'Date Unknown'}] ${c.direction === 'inbound' ? 'From Lead' : 'To Lead'} (${c.channel}): ${c.body}`)
    .join('\n');

  // Format contact person notes
  const contactsText = (contacts || [])
    .map(c => `Contact Person: ${c.first_name || ''} ${c.last_name || ''} (${c.role || 'N/A'})\nNotes: ${c.notes || 'N/A'}`)
    .join('\n');

  const websiteAnalysis = lead.website_analysis || {};

  return `
--- START LEAD CONTEXT ---
Business Name: ${lead.business_name || 'N/A'}
Industry/Category: ${lead.category || 'N/A'}
Address/Location: ${lead.location || 'N/A'}
Google Maps Rating: ${lead.rating || 'N/A'}
Review Count: ${lead.review_count || lead.rating_count || 'N/A'}
Website URL: ${lead.public_website || 'None'}
Phone: ${lead.public_phone || 'N/A'}
Email: ${lead.public_email || 'N/A'}
Pipeline Stage: ${lead.stage || 'NEW'}
CRM Score: ${lead.score || 'N/A'}
Priority: ${lead.priority || 'MEDIUM'}
Qualification Reason: ${lead.qualification_reason || 'N/A'}
Business Description: ${lead.business_description || lead.notes || 'N/A'}

Website Analysis & Issues:
* Accessible: ${websiteAnalysis.accessible !== undefined ? (websiteAnalysis.accessible ? 'Yes' : 'No') : 'N/A'}
* Mobile Friendly: ${websiteAnalysis.mobile_friendly !== undefined ? (websiteAnalysis.mobile_friendly ? 'Yes' : 'No') : 'N/A'}
* Secure HTTPS: ${websiteAnalysis.https_available !== undefined ? (websiteAnalysis.https_available ? 'Yes' : 'No') : 'N/A'}
* Contact Info Present: ${websiteAnalysis.contact_present !== undefined ? (websiteAnalysis.contact_present ? 'Yes' : 'No') : 'N/A'}
* Booking/Order Integration: ${websiteAnalysis.booking_ordering_present !== undefined ? (websiteAnalysis.booking_ordering_present ? 'Yes' : 'No') : 'N/A'}
* Improvement Opportunity: ${websiteAnalysis.improvement_opportunity || 'N/A'}

Contact Details:
${contactsText || 'No contact notes available.'}

Previous Contact History:
${historyText || 'No previous interactions logged.'}

Outreach Settings Context:
- Target Service / Service Selected: ${options.service || 'Web Design, Development & SEO Solutions'}
- Tone Desired: ${options.tone || 'professional'}
- Output Language: ${options.lang || 'English'}
--- END LEAD CONTEXT ---
`;
}

/**
 * Cache operations
 */
async function getCachedAIResponse(leadId, feature) {
  try {
    const rows = await db.findRows('ai_cache', { lead_id: leadId, feature });
    if (rows && rows.length > 0) {
      const sorted = rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return JSON.parse(sorted[0].response_data);
    }
  } catch (e) {
    console.error(`[aiService] Cache read error for lead ${leadId} (${feature}):`, e.message);
  }
  return null;
}

async function setCachedAIResponse(leadId, feature, responseData) {
  try {
    const existing = await db.findRows('ai_cache', { lead_id: leadId, feature });
    for (const row of existing) {
      await db.deleteRow('ai_cache', row.id);
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    await db.insertRow('ai_cache', {
      id,
      lead_id: leadId,
      feature,
      response_data: JSON.stringify(responseData),
      created_at: now,
      updated_at: now
    });
  } catch (e) {
    console.error(`[aiService] Cache write error for lead ${leadId} (${feature}):`, e.message);
  }
}

/**
 * Quality rules helper to clean response text and guarantee JSON parseability
 */
function parseJSONResponse(text, fallbackGenerator) {
  let cleaned = text.trim();
  // Strip markdown wraps if present
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7, cleaned.length - 3).trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3, cleaned.length - 3).trim();
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[aiService] Failed to parse JSON, attempting regex extract:', e.message);
    try {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      }
    } catch {}

    // Regex-based key-value extraction for malformed JSON
    try {
      const result = {};
      const regex = /"([^"]+)"\s*:\s*"([\s\S]*?)"(?=\s*,|\s*})/g;
      let match;
      while ((match = regex.exec(cleaned)) !== null) {
        const key = match[1];
        const val = match[2]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\t/g, '\t');
        result[key] = val;
      }
      if (Object.keys(result).length > 0) {
        console.log('[aiService] Successfully recovered malformed JSON using regex extraction.');
        return result;
      }
    } catch (regexErr) {
      console.error('[aiService] Regex extraction failed:', regexErr.message);
    }
    
    return fallbackGenerator(text);
  }
}

/**
 * 1. POST /api/ai/email
 */
async function generateEmail(leadId, options = {}) {
  const cacheKey = 'email';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
# SYSTEM PROMPT — Autonomous B2B Outreach Email Generator

You are Jarvis, an autonomous B2B lead generation and outreach agent representing **Aandavar Solutions**.

Your responsibility is to write highly personalized, human-sounding outreach emails that inform businesses about website optimization opportunities.

Your primary objective is to build trust and curiosity—never aggressively sell.

IMPORTANT: You must write the email strictly in the requested Output Language (which defaults to English). Even if the business name or audit observations are in another language, translate them appropriately and write the email's subject and body strictly in the requested Output Language.

--------------------------------------------------
TONE & FRAMING RULES
--------------------------------------------------
• Frame all findings as an **"opportunity"** or **"improvement opportunity"**, never as a "problem" or "warning".
• **ABSOLUTELY CRITICAL:** Never use alarmist or negative words. Do NOT use words like: "warning", "vulnerable", "risk", "danger", "hazard", "exposed", "compromised", "insecure", "broken", "critical issue".
• Sound friendly, helpful, conversational, and highly human.
• Reference the business name and exactly ONE specific, real observation from the website audit context.

--------------------------------------------------
SUBJECT LINE RULES
--------------------------------------------------
• Must be truthful and not misleading.
• Length: **Under 6 words** (max 5 words is ideal).
• Do NOT use exclamation marks, ALL CAPS, or spam trigger words ("free", "guarantee", "act now", "click here", "100%", "limited time", "buy now", "urgent", "important").

Good Examples:
- Quick observation for {{company}}
- Website review for {{company}}
- Quick suggestion for {{company}}

--------------------------------------------------
GREETING
--------------------------------------------------
If contact name exists: Hello {{contact_name}},
Otherwise: Hello {{company}} Team,
Never use: "Dear Sir/Madam" or "To whom it may concern".

--------------------------------------------------
BODY & CALL TO ACTION
--------------------------------------------------
• Length: **Under 120 words** (keep it short, direct, and readable).
• Include at most 1 link.
• Frame the audit observation gently. For example:
  "I checked out {{company}}'s website and noticed a couple of quick wins that could help bring in more calls from Google — happy to share what I found if useful."
• **LOW-FRICTION CALL TO ACTION:** You must end the email with a very low-friction, high-value offer that is easy to say yes to. Do NOT ask for a meeting, call, or booking. Instead, offer a free asset (like a 90-second video review, a custom mockup, or a checklist).
  - Good CTA Examples:
    * "I recorded a quick 90-second video showing exactly where your site is losing mobile visitors. Would it be okay if I sent it over?"
    * "I created a quick visual mockup of how your homepage would look with these optimization fixes. Can I email the image to you?"
    * "Would you be open to seeing a quick checklist of the 3 main things holding back your site's speed?"

--------------------------------------------------
MANDATORY COMPLIANCE (US/CAN-SPAM)
--------------------------------------------------
• The signature must contain the sender's clear identity (real name, real reply-to email).
• Do not append physical address or unsubscribe link text here; they will be appended programmatically.

--------------------------------------------------
SIGNATURE
--------------------------------------------------
Always end with:
Regards,

M R Saravana Prabu
Founder | Aandavar Solutions
Email: aandavarsolutions@gmail.com

--------------------------------------------------
QUALITY CHECK & OUTPUT FORMAT
--------------------------------------------------
Verify all constraints before outputting.
You MUST format your output strictly as a JSON object with exactly two fields:
- "subject": The generated subject line (string, under 6 words)
- "body": The generated email body, from greeting to the signature (string, under 120 words)

Return ONLY this JSON object. No explanations, no markdown wraps.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate the B2B outreach email according to your instructions. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    subject: `Website observation for your business`,
    body: text
  }));

  if (result && result.body) {
    const physicalAddress = "Aandavar Solutions, 12 West Cross Street, Salem, TN, India";
    const unsubscribeUrl = `http://localhost:3000/api/unsubscribe?lead_id=${leadId}`;
    const footer = `\n\n---\n${physicalAddress}\nIf you no longer wish to receive these emails, you can unsubscribe here: ${unsubscribeUrl}`;
    
    if (!result.body.includes('unsubscribe') && !result.body.includes('Unsubscribe')) {
      result.body += footer;
    }
  }

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 2. POST /api/ai/whatsapp
 */
async function generateWhatsApp(leadId, options = {}) {
  const cacheKey = 'whatsapp';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
You are an outreach expert. Write a short, highly personalized cold WhatsApp message to the lead based on their B2B details.
Keep it under 3 lines, extremely friendly, direct, and non-spammy. Do not use formal email structures.
Format your response strictly as JSON with exactly one field: "message".

IMPORTANT: You must write the message strictly in the requested Output Language (which defaults to English). Even if the business name or description is in another language, write the message strictly in the requested Output Language.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate the WhatsApp message in the requested tone and language. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    message: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 3. POST /api/ai/call-script
 */
async function generateCallScript(leadId, options = {}) {
  const cacheKey = 'call-script';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
You are a sales training coach. Generate a professional cold call script tailored to this business lead.
Format your response strictly as JSON with exactly these four fields: "opening", "conversation", "objection_handling", "closing".

IMPORTANT: You must write the script strictly in the requested Output Language (which defaults to English). Even if the business name or description is in another language, write the script strictly in the requested Output Language.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate the script in the requested tone and language. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    opening: `Hi, is this the owner of the business?`,
    conversation: text,
    objection_handling: `If they say they are busy, ask if you can send a quick email instead.`,
    closing: `Thanks for your time, let's connect later.`
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 4. POST /api/ai/followup
 */
async function generateFollowUp(leadId, options = {}) {
  const cacheKey = 'followup';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
# SYSTEM PROMPT — B2B Outreach Follow-up Sequence Generator

Generate a sequence of three short, highly professional follow-up messages (First Follow-up, Second Follow-up, Final Follow-up) for this lead.
Format your response strictly as JSON with exactly three fields: "first_followup", "second_followup", "final_followup".

IMPORTANT: You must write all follow-up messages strictly in the requested Output Language (which defaults to English). Write in a helpful, conversational tone.

TONE & WRITING RULES:
• Keep each follow-up under 80 words.
• Never use aggressive sales pressure or pushy language.
• All follow-ups must end with the exact signature below:
  Regards,

  M R Saravana Prabu
  Founder | Aandavar Solutions
  Email: aandavarsolutions@gmail.com

FOLLOW-UP GUIDELINES:
1. "first_followup" (Sent 3-4 days after first touch): A brief, friendly bump referencing the value offer (e.g. the 90-second video or homepage mockup) and asking if they saw it.
2. "second_followup" (Sent 7 days after first touch): Add a specific, friendly value point. Mention how local competitors in their location are using optimization to get customers. Remind them of the free asset you can send.
3. "final_followup" (Breakup Email, sent 10-12 days after first touch): Low pressure, closing the loop. State that you assume this isn't a priority right now, wish them the best with their business, and keep the door open.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate follow-up messages in the requested tone and language. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    first_followup: `Hi, just following up on my previous message.`,
    second_followup: `Hi, I wanted to see if you had a chance to review my offer.`,
    final_followup: `Hi, since I haven't heard back, this will be my final follow-up. Let me know if you change your mind.`
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 5. POST /api/ai/lead-score
 */
async function generateLeadScore(leadId, options = {}) {
  const cacheKey = 'lead-score';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Analyze the lead's business context, rating, reviews, website presence, and communication history to score their potential.
Provide an objective evaluation. Do not hallucinate strengths/weaknesses.
Format your response strictly as JSON with exactly these seven fields:
- "score": integer between 0 and 100
- "priority": "HIGH", "MEDIUM", or "LOW"
- "confidence": "HIGH", "MEDIUM", or "LOW"
- "strengths": array of strings (factual strengths from context)
- "weaknesses": array of strings (factual weaknesses from context)
- "opportunities": array of strings (recommendations, e.g. lacks mobile site, no secure certificate)
- "reasoning": string summarizing why they got this score.
  `;
  const prompt = `
Lead details:
${context}

Analyze the lead and return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    score: 50,
    priority: 'MEDIUM',
    confidence: 'MEDIUM',
    strengths: ['Business is operating'],
    weaknesses: ['Missing website or audit data'],
    opportunities: ['Build or optimize website'],
    reasoning: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 6. POST /api/ai/business-summary
 */
async function generateBusinessSummary(leadId, options = {}) {
  const cacheKey = 'business-summary';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Generate a clear, professional summary of the business lead based ONLY on available facts.
Format your response strictly as JSON with exactly these four fields:
- "business_summary": a paragraph overview of who they are
- "industry": category or industry classification
- "likely_customers": a short description of their target demographic
- "recommended_services": array of services our agency should pitch them (e.g. Web Design, SEO, Google Maps Optimization).
  `;
  const prompt = `
Lead details:
${context}

Summarize and return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    business_summary: text,
    industry: 'Local Business',
    likely_customers: 'Local consumers',
    recommended_services: ['Web Design', 'SEO']
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 7. POST /api/ai/website-audit
 */
async function generateWebsiteAudit(leadId, options = {}) {
  const cacheKey = 'website-audit';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Analyze the lead's website metrics.
If they have a website: Evaluate mobile friendliness, accessibility, speed, SEO, security, and user experience based on the audit notes.
If they lack a website: Focus on why they need a website immediately to compete in their industry.
Format your response strictly as JSON with exactly these three fields:
- "issues": array of strings listing detected or likely problems
- "improvements": array of strings detailing what should be fixed
- "service_recommendations": array of services our agency can sell them to resolve these issues.
  `;
  const prompt = `
Lead details:
${context}

Run the audit/recommendation logic and return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    issues: ['No website found or analyzed'],
    improvements: ['Build a new website'],
    service_recommendations: ['Web Design Package']
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 8. POST /api/ai/sales-pitch
 */
async function generateSalesPitch(leadId, options = {}) {
  const cacheKey = 'sales-pitch';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Create a compelling sales pitch tailored for this business lead.
Format your response strictly as JSON with exactly these two fields:
- "elevator_pitch": a concise 1-2 sentence hook
- "long_pitch": a 2-paragraph value proposition detailing benefits.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate the pitches in the requested tone and language. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    elevator_pitch: `We help businesses like yours stand out online.`,
    long_pitch: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 9. POST /api/ai/proposal
 */
async function generateProposal(leadId, options = {}) {
  const cacheKey = 'proposal';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
You are a senior proposal writer. Write a comprehensive, professional business proposal in clean Markdown.
Structure your proposal strictly with these headings:
# Business Proposal
## Introduction
## Problem Statement
## Proposed Solution
## Deliverables
## Project Timeline
## Estimated Benefits
## Next Steps & Closing

Use facts from the lead context. Do not invent pricing or custom integrations not mentioned, keep it realistic.
This endpoint does NOT return JSON. Return markdown text directly.
  `;
  const prompt = `
Lead details:
${context}

${options.customPrompt ? `Additional guidelines: ${options.customPrompt}` : ''}
Generate the proposal in the requested language.
  `;

  const markdown = await callGemini(prompt, systemInstruction, null);
  const result = { proposal: markdown };

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 10. POST /api/ai/meeting-prep
 */
async function generateMeetingPrep(leadId, options = {}) {
  const cacheKey = 'meeting-prep';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Prepare a briefing sheet for a sales meeting with this lead.
Format your response strictly as JSON with exactly these four fields:
- "talking_points": array of strings
- "questions_to_ask": array of strings
- "likely_objections": array of strings
- "recommended_approach": a paragraph explaining the best strategy.
  `;
  const prompt = `
Lead details:
${context}

Generate meeting prep. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    talking_points: ['Discuss online presence'],
    questions_to_ask: ['What are your current goals?'],
    likely_objections: ['Too expensive', 'No time'],
    recommended_approach: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 11. POST /api/ai/objection-reply
 */
async function generateObjectionReply(leadId, objection, options = {}) {
  const cacheKey = `objection_${objection.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}`;
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
The prospective customer has raised an objection. Write a professional, polite, and persuasive response to overcome it.
Objection raised: "${objection}"
Format your response strictly as JSON with exactly one field: "response".
  `;
  const prompt = `
Lead details:
${context}

Generate response. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    response: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 12. POST /api/ai/reply
 */
async function generateReply(leadId, customerEmail, options = {}) {
  const cacheKey = `reply_${customerEmail.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}`;
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
The customer sent this email: "${customerEmail}"
Write a professional, helpful response addressing their email. Keep it concise.
Format your response strictly as JSON with exactly one field: "response".
  `;
  const prompt = `
Lead details:
${context}

Generate response. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    response: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 13. POST /api/ai/tags
 */
async function generateTags(leadId, options = {}) {
  const cacheKey = 'tags';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Analyze the lead's context and output a set of 3 to 6 matching CRM tags.
Example tags: "High Priority", "Needs Website", "SEO", "Restaurant", "Follow Up", "Hot Lead", "Cold Lead", "Low rating".
Format your response strictly as JSON with exactly one field: "tags", which must be an array of strings.
  `;
  const prompt = `
Lead details:
${context}

Generate tags. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    tags: ['Prospect', 'Local Service']
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 14. POST /api/ai/next-action
 */
async function generateNextAction(leadId, options = {}) {
  const cacheKey = 'next-action';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Recommend the single best next action for this lead.
Format your response strictly as JSON with exactly these two fields:
- "action": must be one of "Call", "Email", "WhatsApp", "Visit", or "Ignore"
- "reasoning": a paragraph explanation of why this action is recommended.
  `;
  const prompt = `
Lead details:
${context}

Recommend next action. Return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    action: 'Email',
    reasoning: text
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 15. POST /api/ai/closing-probability
 */
async function generateClosingProbability(leadId, options = {}) {
  const cacheKey = 'closing-probability';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
Analyze the lead's history, website audit, rating, and feedback to estimate the closing probability.
Format your response strictly as JSON with exactly these three fields:
- "probability": integer percentage from 0 to 100
- "reasons": array of strings explaining the factors
- "recommended_next_step": a sentence explaining what to do next to close the deal.
  `;
  const prompt = `
Lead details:
${context}

Analyze probability and return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    probability: 40,
    reasons: ['No previous response'],
    recommended_next_step: 'Send personalized pitch.'
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

/**
 * 16. POST /api/ai/seo
 */
async function generateSEO(leadId, options = {}) {
  const cacheKey = 'seo';
  if (!options.regenerate) {
    const cached = await getCachedAIResponse(leadId, cacheKey);
    if (cached) return cached;
  }

  const context = await getLeadPromptContext(leadId, options);
  const systemInstruction = `
If the lead has a website, audit its SEO. If not, recommend local keywords and setup SEO guidelines.
Format your response strictly as JSON with exactly these five fields:
- "seo_issues": array of strings listing visible issues
- "meta_title_suggestions": array of strings (specific page title recommendations)
- "meta_description": a recommended homepage meta description
- "keyword_ideas": array of high-value local keywords
- "content_improvements": array of content recommendations.

IMPORTANT: You must write the audit results and suggestions strictly in English. Even if the business name or website content is in another language, translate them in your mind and output all JSON values strictly in English.
  `;
  const prompt = `
Lead details:
${context}

Audit SEO and return JSON only.
  `;

  const raw = await callGemini(prompt, systemInstruction, 'application/json');
  const result = parseJSONResponse(raw, (text) => ({
    seo_issues: ['Meta tags are generic'],
    meta_title_suggestions: ['Best service near you'],
    meta_description: 'We offer professional local services.',
    keyword_ideas: ['web design near me'],
    content_improvements: ['Add customer testimonials']
  }));

  await setCachedAIResponse(leadId, cacheKey, result);
  return result;
}

module.exports = {
  getGeminiKey,
  callGemini,
  generateEmail,
  generateWhatsApp,
  generateCallScript,
  generateFollowUp,
  generateLeadScore,
  generateBusinessSummary,
  generateWebsiteAudit,
  generateSalesPitch,
  generateProposal,
  generateMeetingPrep,
  generateObjectionReply,
  generateReply,
  generateTags,
  generateNextAction,
  generateClosingProbability,
  generateSEO
};
