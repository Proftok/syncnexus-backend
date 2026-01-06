const express = require('express');
const router = express.Router();
const db = require('../config/db');
const axios = require('axios');

// 1. INJECT MEMBERS (Batch)
router.post('/inject-members', async (req, res) => {
    const { members } = req.body;
    // Use ENV or Fallback (For Inject Tool)
    const GROUP_JID = process.env.CEO_GROUP_ID;

    if (!GROUP_JID) return res.status(500).json({ error: "Missing CEO_GROUP_ID in environment" });

    if (!members || !Array.isArray(members)) return res.status(400).json({ error: 'Invalid members' });
    console.log(`💉 INJECT: Processing batch of ${members.length}...`);

    let inserted = 0;
    let updated = 0;

    try {
        const groupRes = await db.query('SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1', [GROUP_JID]);
        const intGroupId = groupRes.rows[0]?.group_id;
        if (!intGroupId) throw new Error(`Group ${GROUP_JID} not found`);

        for (const m of members) {
            if (!m.whatsapp_id || !m.whatsapp_id.includes('@s.whatsapp.net')) continue;

            // Upsert Member
            const mUpsert = await db.query(`
              INSERT INTO crm.wa_members (whatsapp_id, display_name) VALUES ($1, $2)
              ON CONFLICT (whatsapp_id) DO UPDATE
              SET display_name = COALESCE(EXCLUDED.display_name, crm.wa_members.display_name)
              RETURNING member_id
            `, [m.whatsapp_id, m.display_name]);

            let intMemberId = mUpsert.rows[0]?.member_id;
            if (!intMemberId) {
                const exist = await db.query('SELECT member_id FROM crm.wa_members WHERE whatsapp_id = $1', [m.whatsapp_id]);
                intMemberId = exist.rows[0].member_id;
            }

            // Update Name override logic
            if (m.display_name && m.display_name.length > 1) {
                const up = await db.query(`
                  UPDATE crm.wa_members SET display_name = $1
                  WHERE member_id = $2 AND (display_name IS NULL OR display_name = whatsapp_id OR display_name = 'Unknown')
               `, [m.display_name, intMemberId]);
                if (up.rowCount > 0) updated++;
            }

            // Link
            await db.query(`
               INSERT INTO crm.wa_groupmembers (group_id, member_id, is_admin)
               VALUES ($1, $2, false) ON CONFLICT (group_id, member_id) DO NOTHING
            `, [intGroupId, intMemberId]);
            inserted++;
        }
        res.json({ success: true, processed: inserted, updatedNames: updated });
    } catch (err) {
        console.error('Inject Failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. VERIFY SYNC
router.post('/verify-group-sync', async (req, res) => {
    const { groupJid, instanceName } = req.body;
    const finalInstanceName = instanceName || 'sa-personal';

    try {
        const evolutionUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;

        // Fetch Evo
        const response = await axios.get(
            `${evolutionUrl}/group/participants/${finalInstanceName}?groupJid=${groupJid}`,
            { headers: { 'apikey': apiKey } }
        ).catch(() => ({ data: [] }));

        let evoList = [];
        const p = response.data;
        if (Array.isArray(p)) evoList = p;
        else if (p.data) evoList = p.data;
        else if (p.participants) evoList = p.participants;

        // Get DB
        const groupRes = await db.query('SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1', [groupJid]);
        let dbCount = 0;
        if (groupRes.rows.length > 0) {
            const intGroupId = groupRes.rows[0].group_id;
            const dbMembers = await db.query('SELECT COUNT(*) FROM crm.wa_groupmembers WHERE group_id = $1', [intGroupId]);
            dbCount = parseInt(dbMembers.rows[0].count);
        }

        res.json({
            evolution_count_raw: evoList.length,
            db_count: dbCount,
            status: dbCount >= evoList.length ? 'MATCHED' : 'INCOMPLETE'
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
