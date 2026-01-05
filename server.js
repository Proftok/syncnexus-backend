require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// PostgreSQL connection
const db = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  searchPath: ['crm']
});

// Test database connection
db.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected');
    release();
  }
});

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'https://syncnexus.aifund.co.za',
      'https://syncnexus-brain-core-5.aifund.co.za', // Just in case
      'http://localhost:3000',
      'http://localhost:5173'
    ];

    // Check if the origin is in our allowed list or is a subdomain of aifund.co.za
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.aifund.co.za')) {
      callback(null, true);
    } else {
      console.warn('CORS Blocked Origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey']
}));
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: 'connected'
  });
});

// ============================================
// API ENDPOINTS
// ============================================

// Dashboard Stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const statsResult = await db.query(`
      SELECT * FROM crm.wa_system_stats 
      WHERE date = CURRENT_DATE
    `);

    const groupsResult = await db.query(`
      SELECT 
        COUNT(*) as total_groups,
        COUNT(*) FILTER (WHERE group_category = 'businesssa') as sa_groups,
        COUNT(*) FILTER (WHERE is_eo_group = true) as eo_groups
      FROM crm.wa_groups 
      WHERE is_active = true
    `);

    const membersResult = await db.query(`
      SELECT COUNT(*) as monitored_contacts
      FROM crm.wa_members
      WHERE monitoring_enabled = true
    `);

    const messagesResult = await db.query(`
      SELECT COUNT(*) as high_value_messages
      FROM crm.wa_message_analysis
      WHERE should_reply = true 
      AND human_reviewed = false
      AND created_at > NOW() - INTERVAL '24 hours'
    `);

    const stats = statsResult.rows[0] || {};
    const groups = groupsResult.rows[0];
    const members = membersResult.rows[0];
    const messages = messagesResult.rows[0];

    res.json({
      totalGroups: parseInt(groups.total_groups) || 0,
      saGroups: parseInt(groups.sa_groups) || 0,
      eoGroups: parseInt(groups.eo_groups) || 0,
      monitoredContacts: parseInt(members.monitored_contacts) || 0,
      highValueMessages24h: parseInt(messages.high_value_messages) || 0,
      pendingDrafts: parseInt(messages.high_value_messages) || 0,
      totalCostUsd: parseFloat(stats.total_cost_usd) || 0,
      totalTokensUsed: parseInt(stats.total_tokens_used) || 0
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get Groups
app.get('/api/groups', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        group_id as "groupId",
        whatsapp_group_id as jid,
        group_name as "groupName",
        group_description as "groupDescription",
        participant_count as "memberCount",
        monitoring_enabled as "monitoringEnabled",
        priority_level as "priorityLevel",
        group_category as "groupCategory",
        is_eo_group as "isEoGroup",
        instance_id as "instanceId"
      FROM crm.wa_groups
      WHERE is_active = true
      ORDER BY priority_level DESC, group_name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get Members (Contacts)
app.get('/api/members', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        member_id as "memberId",
        whatsapp_id as "whatsappMemberId",
        display_name as "displayName",
        phone_number as "phoneNumber",
        company_name as "companyName",
        job_title as "jobTitle",
        is_eo_member as "isEoMember",
        eo_chapter as "eoChapter",
        is_ypo_member as "isYpoMember",
        ypo_chapter as "ypoChapter",
        is_direct as "isDirect",
        monitoring_enabled as "monitoringEnabled",
        chat_profile_summary as "chatProfileSummary",
        expertise_tags as "expertiseTags",
        linkedin_url as "linkedinUrl",
        linkedin_birthday as "linkedinBirthday",
        last_active_at as "lastActiveAt",
        total_messages_sent as "totalMessagesSent"
      FROM crm.wa_members
      ORDER BY last_active_at DESC NULLS LAST
      LIMIT 1000
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Get AI Inbox (High-Value Messages)
app.get('/api/inbox/high-value', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        a.analysis_id as id,
        a.message_id as "messageId",
        m.sender_id as "senderId",
        m.group_id as "groupId",
        mem.display_name as "senderName",
        mem.is_eo_member as "senderIsEoMember",
        mem.eo_chapter as "senderEoChapter",
        g.group_name as "groupName",
        g.whatsapp_group_id as "groupJid",
        m.message_content as "messageBody",
        a.value_score as "valueScore",
        a.intent_category as "intentCategory",
        a.reasoning,
        a.group_draft as "groupDraft",
        a.dm_draft as "dmDraft",
        a.should_reply as "shouldReply",
        a.created_at as "createdAt"
      FROM crm.wa_message_analysis a
      JOIN crm.wa_messages m ON a.message_id = m.message_id
      JOIN crm.wa_members mem ON m.sender_id = mem.member_id
      LEFT JOIN crm.wa_groups g ON m.group_id = g.group_id
      WHERE a.should_reply = true 
      AND a.human_reviewed = false
      ORDER BY a.value_score DESC, a.created_at DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching inbox:', error);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

// Get Upcoming Birthdays
app.get('/api/social/birthdays/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    const result = await db.query(`
      SELECT 
        member_id as "memberId",
        display_name as name,
        phone_number as "phoneNumber",
        company_name as "companyName",
        linkedin_birthday as "linkedinBirthday",
        TO_CHAR(linkedin_birthday, 'Mon DD') as "birthdayDate"
      FROM crm.wa_members
      WHERE linkedin_birthday IS NOT NULL
      AND EXTRACT(MONTH FROM linkedin_birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
      AND EXTRACT(DAY FROM linkedin_birthday) >= EXTRACT(DAY FROM CURRENT_DATE)
      ORDER BY EXTRACT(DAY FROM linkedin_birthday)
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching birthdays:', error);
    res.status(500).json({ error: 'Failed to fetch birthdays' });
  }
});

// Get Recent LinkedIn Posts
app.get('/api/social/linkedin/recent-posts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    const result = await db.query(`
      SELECT 
        l.activity_id as "postId",
        m.display_name as name,
        m.phone_number as "phoneNumber",
        l.post_date as "postDate",
        l.post_summary as "postSummary",
        l.engagement_opportunity as "engagementOpportunity",
        CASE 
          WHEN l.post_date > NOW() - INTERVAL '1 hour' THEN EXTRACT(EPOCH FROM (NOW() - l.post_date))/60 || 'm ago'
          WHEN l.post_date > NOW() - INTERVAL '24 hours' THEN EXTRACT(EPOCH FROM (NOW() - l.post_date))/3600 || 'h ago'
          ELSE EXTRACT(EPOCH FROM (NOW() - l.post_date))/86400 || 'd ago'
        END as "postDate"
      FROM crm.wa_linkedin_activity l
      JOIN crm.wa_members m ON l.member_id = m.member_id
      WHERE l.post_date >= NOW() - INTERVAL '${days} days'
      AND l.is_processed = false
      ORDER BY l.post_date DESC
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching LinkedIn activity:', error);
    res.status(500).json({ error: 'Failed to fetch LinkedIn activity' });
  }
});

// Update Group Settings
app.patch('/api/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { monitoringEnabled, priorityLevel, groupCategory } = req.body;

    const result = await db.query(`
      UPDATE crm.wa_groups
      SET 
        monitoring_enabled = COALESCE($1, monitoring_enabled),
        priority_level = COALESCE($2, priority_level),
        group_category = COALESCE($3, group_category),
        updated_at = NOW()
      WHERE group_id = $4
      RETURNING *
    `, [monitoringEnabled, priorityLevel, groupCategory, groupId]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Update Member Settings
app.patch('/api/members/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { monitoringEnabled, enrichmentPriority, isDirect } = req.body;

    const result = await db.query(`
      UPDATE crm.wa_members
      SET 
        monitoring_enabled = COALESCE($1, monitoring_enabled),
        enrichment_priority = COALESCE($2, enrichment_priority),
        is_direct = COALESCE($3, is_direct),
        updated_at = NOW()
      WHERE member_id = $4
      RETURNING *
    `, [monitoringEnabled, enrichmentPriority, isDirect, memberId]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating member:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Helper: Get or Create Instance ID
async function getOrCreateInstanceId(evolutionInstanceName) {
  if (!evolutionInstanceName) return null;

  try {
    const result = await db.query('SELECT instance_id FROM crm.wa_instances WHERE evolution_instance_id = $1', [evolutionInstanceName]);
    if (result.rows.length > 0) return result.rows[0].instance_id;

    // Create if not exists
    console.log(`🆕 Registering new instance: ${evolutionInstanceName}`);
    const insert = await db.query(`
      INSERT INTO crm.wa_instances (instance_name, evolution_instance_id, is_active, is_primary)
      VALUES ($1, $1, true, false)
      RETURNING instance_id
    `, [evolutionInstanceName]);

    return insert.rows[0].instance_id;
  } catch (err) {
    console.error(`Error getting instance ID for ${evolutionInstanceName}:`, err.message);
    return null;
  }
}

// ============================================
// EVOLUTION API WEBHOOK HANDLER
// ============================================

app.post('/webhook/evolution', async (req, res) => {
  try {
    const { event, instance, data } = req.body;

    // console.log('📨 Webhook received:', event, instance);

    // Only process new messages
    if (event !== 'messages.upsert') {
      return res.sendStatus(200);
    }

    // Extract message data
    const messageId = data.key.id;
    const groupJid = data.key.remoteJid;
    const senderJid = data.key.participant || data.key.remoteJid;
    const messageBody = data.message?.conversation ||
      data.message?.extendedTextMessage?.text || '';
    const timestamp = new Date(data.messageTimestamp * 1000);

    // Skip if empty
    if (!messageBody) return res.sendStatus(200);

    // Get Instance ID
    const instanceId = await getOrCreateInstanceId(instance);

    // Check if message already exists (deduplication)
    const existing = await db.query(
      'SELECT message_id FROM crm.wa_messages WHERE whatsapp_message_id = $1',
      [messageId]
    );

    if (existing.rows.length > 0) return res.sendStatus(200);

    // Find or create group
    let group = await db.query(
      'SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1',
      [groupJid]
    );

    if (group.rows.length === 0) {
      if (!instanceId) console.warn(`⚠️ Creating group ${groupJid} without instance ID`);
      const insertGroup = await db.query(`
        INSERT INTO crm.wa_groups (whatsapp_group_id, group_name, is_active, instance_id)
        VALUES ($1, $2, true, $3)
        RETURNING group_id
      `, [groupJid, 'Unknown Group', instanceId]);
      group = insertGroup;
    }

    const groupId = group.rows[0].group_id;

    // Find or create member
    let member = await db.query(
      'SELECT member_id FROM crm.wa_members WHERE whatsapp_id = $1',
      [senderJid]
    );

    if (member.rows.length === 0) {
      const insertMember = await db.query(`
        INSERT INTO crm.wa_members (whatsapp_id, display_name, phone_number)
        VALUES ($1, $2, $3)
        RETURNING member_id
      `, [senderJid, data.pushName || 'Unknown', senderJid.split('@')[0]]);
      member = insertMember;
    }

    const memberId = member.rows[0].member_id;

    // Save message
    const messageResult = await db.query(`
      INSERT INTO crm.wa_messages (
        whatsapp_message_id, group_id, sender_id, 
        message_type, message_content, timestamp
      )
      VALUES ($1, $2, $3, 'text', $4, $5)
      RETURNING message_id
    `, [messageId, groupId, memberId, messageBody, timestamp]);

    // Update system stats
    await db.query(`
      UPDATE crm.wa_system_stats
      SET total_messages_processed = total_messages_processed + 1
      WHERE date = CURRENT_DATE
    `);

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// BACKGROUND JOBS
// ============================================

// Daily stats reset (runs at midnight)
cron.schedule('0 0 * * *', async () => {
  console.log('🔄 Running daily stats reset...');
  try {
    await db.query(`
      INSERT INTO crm.wa_system_stats (date)
      VALUES (CURRENT_DATE)
      ON CONFLICT (date) DO NOTHING
    `);
    console.log('✅ Stats reset complete');
  } catch (error) {
    console.error('❌ Stats reset failed:', error);
  }
});

// LinkedIn birthday enrichment (runs at 6 AM)
cron.schedule('0 6 * * *', async () => {
  console.log('🎂 Running birthday enrichment...');
  // TODO: Implement LinkedIn scraping
});

// ============================================
// SYNC ENDPOINTS
// ============================================

// Sync All Groups from Evolution API
app.post('/api/sync/groups', async (req, res) => {
  try {
    const { instanceName } = req.body; // Accept dynamic instance name
    const finalInstanceName = instanceName || 'sa-personal'; // Default Fallback

    console.log(`🔄 Starting group sync for ${finalInstanceName}...`);

    const evolutionUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!evolutionUrl || !apiKey) {
      throw new Error('Missing EVOLUTION_API_URL or EVOLUTION_API_KEY');
    }

    // Ensure instance exists in DB
    const instanceId = await getOrCreateInstanceId(finalInstanceName);
    if (!instanceId) throw new Error(`Could not find or create instance ID for ${finalInstanceName}`);

    // Fetch all groups from Evolution API
    const response = await axios.get(
      `${evolutionUrl}/group/fetchAllGroups/${finalInstanceName}?getParticipants=true`,
      {
        headers: { 'apikey': apiKey }
      }
    );

    const groups = response.data;

    if (!Array.isArray(groups)) throw new Error("Invalid response from Evolution API");

    console.log(`📡 Fetched ${groups.length} groups.`);

    let syncedCount = 0;

    // Insert each group
    for (const group of groups) {
      try {
        const participantCount = group.participants ? group.participants.length : 0;

        await db.query(`
            INSERT INTO crm.wa_groups (
              whatsapp_group_id, group_name, group_description, instance_id, is_active, participant_count
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (whatsapp_group_id) DO UPDATE
            SET group_name = EXCLUDED.group_name,
                group_description = COALESCE(EXCLUDED.group_description, crm.wa_groups.group_description),
                participant_count = EXCLUDED.participant_count,
                instance_id = EXCLUDED.instance_id, -- Update instance binding if needed
                updated_at = NOW()
          `, [
          group.id,
          group.subject || 'Unknown Group',
          group.desc || group.description || null,
          instanceId,
          false,
          participantCount
        ]);
        syncedCount++;
      } catch (innerErr) {
        console.error(`Failed to save group ${group.subject}:`, innerErr.message);
      }
    }

    res.json({ success: true, totalFetched: groups.length, synced: syncedCount });

  } catch (error) {
    console.error('❌ Error syncing groups:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 SyncNexus Backend Server');
  console.log('================================');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🗄️  Database: ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully...');
  db.end(() => {
    console.log('💾 Database connections closed');
    process.exit(0);
  });
});