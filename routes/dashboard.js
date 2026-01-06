const express = require('express');
const router = express.Router();
const db = require('../config/db');

// DASHBOARD STATS
router.get('/stats', async (req, res) => {
    try {
        const statsResult = await db.query(`SELECT * FROM crm.wa_system_stats WHERE date = CURRENT_DATE`);
        const groupsResult = await db.query(`SELECT COUNT(*) as total_groups, COUNT(*) FILTER (WHERE group_category = 'businesssa') as sa_groups, COUNT(*) FILTER (WHERE is_eo_group = true) as eo_groups FROM crm.wa_groups WHERE is_active = true`);
        const membersResult = await db.query(`SELECT COUNT(*) as monitored_contacts FROM crm.wa_members WHERE monitoring_enabled = true`);
        const messagesResult = await db.query(`SELECT COUNT(*) as high_value_messages FROM crm.wa_message_analysis WHERE should_reply = true AND human_reviewed = false AND created_at > NOW() - INTERVAL '24 hours'`);

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
    } catch (error) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// GET GROUPS
router.get('/groups', async (req, res) => {
    try {
        const result = await db.query(`
        SELECT group_id as "groupId", whatsapp_group_id as jid, group_name as "groupName", group_description as "groupDescription", participant_count as "memberCount", monitoring_enabled as "monitoringEnabled", priority_level as "priorityLevel", group_category as "groupCategory", is_eo_group as "isEoGroup", instance_id as "instanceId"
        FROM crm.wa_groups WHERE is_active = true ORDER BY priority_level DESC, group_name ASC
      `);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// GET MEMBERS
router.get('/members', async (req, res) => {
    try {
        const result = await db.query(`
        SELECT member_id as "memberId", whatsapp_id as "whatsappMemberId", display_name as "displayName", phone_number as "phoneNumber", company_name as "companyName", job_title as "jobTitle", is_eo_member as "isEoMember", eo_chapter as "eoChapter", is_ypo_member as "isYpoMember", ypo_chapter as "ypoChapter", is_direct as "isDirect", monitoring_enabled as "monitoringEnabled", chat_profile_summary as "chatProfileSummary", expertise_tags as "expertiseTags", linkedin_url as "linkedinUrl", linkedin_birthday as "linkedinBirthday", last_active_at as "lastActiveAt", total_messages_sent as "totalMessagesSent"
        FROM crm.wa_members ORDER BY last_active_at DESC NULLS LAST LIMIT 1000
      `);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

// INBOX
router.get('/inbox/high-value', async (req, res) => {
    try {
        const result = await db.query(`
        SELECT a.analysis_id as id, a.message_id as "messageId", m.sender_id as "senderId", m.group_id as "groupId", mem.display_name as "senderName", mem.is_eo_member as "senderIsEoMember", mem.eo_chapter as "senderEoChapter", g.group_name as "groupName", g.whatsapp_group_id as "groupJid", m.message_content as "messageBody", a.value_score as "valueScore", a.intent_category as "intentCategory", a.reasoning, a.group_draft as "groupDraft", a.dm_draft as "dmDraft", a.should_reply as "shouldReply", a.created_at as "createdAt"
        FROM crm.wa_message_analysis a JOIN crm.wa_messages m ON a.message_id = m.message_id JOIN crm.wa_members mem ON m.sender_id = mem.member_id LEFT JOIN crm.wa_groups g ON m.group_id = g.group_id
        WHERE a.should_reply = true AND a.human_reviewed = false ORDER BY a.value_score DESC, a.created_at DESC LIMIT 50
      `);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

module.exports = router;
