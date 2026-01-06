const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/db');

// Helper: Get or Create Instance ID
async function getOrCreateInstanceId(evolutionInstanceName) {
    if (!evolutionInstanceName) return null;
    try {
        const result = await db.query(
            'SELECT instance_id FROM crm.wa_instances WHERE evolution_instance_id = $1',
            [evolutionInstanceName]
        );

        if (result.rows.length > 0) return result.rows[0].instance_id;

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

// 1. SYNC ALL GROUPS (Metadata)
router.post('/groups', async (req, res) => {
    try {
        const { instanceName } = req.body;
        const finalInstanceName = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'sa-personal';
        console.log(`🔄 Starting group sync (Metadata Only) for ${finalInstanceName}...`);

        const evolutionUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;
        if (!evolutionUrl || !apiKey) throw new Error('Missing Evolution Config');

        const instanceId = await getOrCreateInstanceId(finalInstanceName);
        if (!instanceId) throw new Error(`Could not find instance ID`);

        // getParticipants=false to prevent timeout
        const response = await axios.get(
            `${evolutionUrl}/group/fetchAllGroups/${finalInstanceName}?getParticipants=false`,
            { headers: { 'apikey': apiKey } }
        );

        const groups = response.data;
        if (!Array.isArray(groups)) throw new Error("Invalid response from Evolution API");

        let syncedCount = 0;
        for (const group of groups) {
            try {
                await db.query(`
              INSERT INTO crm.wa_groups (
                whatsapp_group_id, group_name, group_description, instance_id, is_active, participant_count
              ) VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (whatsapp_group_id) DO UPDATE
              SET group_name = EXCLUDED.group_name,
                  updated_at = NOW()
            `, [
                    group.id, group.subject || 'Unknown Group', group.desc || null, instanceId, true, group.size || 0
                ]);
                syncedCount++;
            } catch (innerErr) { console.error(`Failed to save group ${group.subject}:`, innerErr.message); }
        }
        res.json({ success: true, totalFetched: groups.length, synced: syncedCount });
    } catch (error) {
        console.error('❌ Error syncing groups:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. PILOT SYNC (Deep member sync with Integer Fix)
router.post('/group-names', async (req, res) => {
    const { groupJid, instanceName } = req.body;
    const finalInstanceName = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'sa-personal';

    console.log(`🛠️ SYNC & RESCUE: Starting Deep Sync for ${groupJid}...`);
    const evolutionUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    try {
        const instanceId = await getOrCreateInstanceId(finalInstanceName);

        // Ensure Group Exists first
        await db.query(`
         INSERT INTO crm.wa_groups (whatsapp_group_id, group_name, is_active, instance_id)
         VALUES ($1, 'Synced Group', true, $2)
         ON CONFLICT (whatsapp_group_id) DO NOTHING
      `, [groupJid, instanceId]);

        // FETCH METADATA
        const response = await axios.get(
            `${evolutionUrl}/group/findGroupInfos/${finalInstanceName}?groupJid=${groupJid}`,
            { headers: { 'apikey': apiKey } }
        ).catch(e => ({ data: { participants: [] } }));

        const groupInfo = response.data;
        const membersList = groupInfo.participants || [];
        if (!membersList || membersList.length === 0) throw new Error("No participants found.");

        let insertedCount = 0;
        let updatedCount = 0;

        // 1. FIRST PASS
        for (const p of membersList) {
            let waId = null;
            if (p.phoneNumber && typeof p.phoneNumber !== 'object') waId = p.phoneNumber;
            if (!waId && typeof p.id === 'string' && p.id.includes('@s.whatsapp.net')) waId = p.id;
            if (!waId && p.phoneNumber) waId = p.phoneNumber; // Fallback

            if (!waId) continue;
            waId = waId.split(':')[0];
            if (!waId.includes('@s.whatsapp.net')) waId += '@s.whatsapp.net';

            // UPSERT MEMBER
            await db.query(`
              INSERT INTO crm.wa_members (whatsapp_id, display_name)
              VALUES ($1, NULL) ON CONFLICT (whatsapp_id) DO NOTHING
         `, [waId]);

            // RESOLVE IDS (Integer Fix)
            const memberRes = await db.query('SELECT member_id FROM crm.wa_members WHERE whatsapp_id = $1', [waId]);
            const groupRes = await db.query('SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1', [groupJid]);

            if (memberRes.rows.length > 0 && groupRes.rows.length > 0) {
                const intMemberId = memberRes.rows[0].member_id;
                const intGroupId = groupRes.rows[0].group_id;
                const linkRes = await db.query(`
                  INSERT INTO crm.wa_groupmembers (group_id, member_id, is_admin)
                  VALUES ($1, $2, $3) ON CONFLICT (group_id, member_id) DO NOTHING
             `, [intGroupId, intMemberId, p.admin === 'admin' || p.admin === 'superadmin']);
                if (linkRes.rowCount > 0) insertedCount++;
            }

            // RESCUE NAME
            const rawName = p.pushName || p.notify || p.name;
            if (rawName) {
                const result = await db.query(`
                UPDATE crm.wa_members SET display_name = $1 
                WHERE whatsapp_id = $2 
                AND (display_name IS NULL OR display_name = whatsapp_id OR display_name = 'Unknown' OR display_name ~ '^[0-9\\s\\+\\(\\-)]*$')
            `, [`~${rawName}`, waId]);
                if (result.rowCount > 0) updatedCount++;
            }
        }

        res.json({ success: true, fixed: insertedCount, totalMetadataScanned: membersList.length });
    } catch (error) {
        console.error('Group Sync Failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 3. MASS SYNC (All Groups + Participants)
router.post('/full-sync', async (req, res) => {
    try {
        const { instanceName } = req.body;
        const finalInstanceName = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'sa-personal';

        console.log(`🚀 STARTING MASS SYNC for ${finalInstanceName}...`);

        const evolutionUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;
        const instanceId = await getOrCreateInstanceId(finalInstanceName);

        // 1. Get ALL Groups first
        const groupsRes = await axios.get(
            `${evolutionUrl}/group/fetchAllGroups/${finalInstanceName}?getParticipants=false`,
            { headers: { 'apikey': apiKey } }
        );
        const groups = groupsRes.data;
        console.log(`Found ${groups.length} groups. Starting Deep Sync...`);

        // Start background process (don't block UI)
        res.json({ success: true, message: `Started syncing ${groups.length} groups in background.` });

        // BACKGROUND WORKER
        (async () => {
            let processed = 0;
            for (const group of groups) {
                processed++;
                const jid = group.id;
                console.log(`[${processed}/${groups.length}] Syncing ${group.subject}...`);

                try {
                    // Update Group Metadata
                    await db.query(`
                        INSERT INTO crm.wa_groups (whatsapp_group_id, group_name, participant_count, instance_id, is_active)
                        VALUES ($1, $2, $3, $4, true)
                        ON CONFLICT (whatsapp_group_id) DO UPDATE SET updated_at = NOW()
                    `, [jid, group.subject, group.size, instanceId]);

                    // Fetch Participants
                    const groupInfo = await axios.get(
                        `${evolutionUrl}/group/findGroupInfos/${finalInstanceName}?groupJid=${jid}`,
                        { headers: { 'apikey': apiKey } }
                    ).catch(() => ({ data: {} }));

                    const participants = groupInfo.data.participants || [];

                    // Bulk Insert Participants (Simplified for speed)
                    for (const p of participants) {
                        let waId = (p.id || p.phoneNumber || '').split(':')[0];
                        if (!waId.includes('@')) waId += '@s.whatsapp.net';

                        // Insert Member
                        await db.query(`INSERT INTO crm.wa_members (whatsapp_id, display_name) VALUES ($1, $2) ON CONFLICT (whatsapp_id) DO NOTHING`, [waId, p.notify || p.id]);

                        // Insert Link
                        await db.query(`
                          INSERT INTO crm.wa_groupmembers (group_id, member_id, is_admin)
                          SELECT g.group_id, m.member_id, $3
                          FROM crm.wa_groups g, crm.wa_members m
                          WHERE g.whatsapp_group_id = $1 AND m.whatsapp_id = $2
                          ON CONFLICT (group_id, member_id) DO NOTHING
                        `, [jid, waId, p.admin === 'admin']);
                    }

                    // Rate Limit Prevention
                    await delay(1000);

                } catch (e) {
                    console.error(`Failed to sync ${group.subject}:`, e.message);
                }
            }
            console.log("✅ MASS SYNC COMPLETE");
        })();

    } catch (error) {
        console.error("Mass Sync Error:", error);
        // If response wasn't sent yet
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

module.exports = router;
