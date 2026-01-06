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

// 3. SYNC MESSAGES (Fixed for Evolution API v2.3.x)
router.post('/messages', async (req, res) => {
  try {
    const { groupJid, instanceName, limit } = req.body;
    const finalInstanceName = instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'sa-personal';
    const messageLimit = limit || 100;

    console.log(`💬 Starting message sync for ${groupJid} (limit: ${messageLimit})...`);

    const evolutionUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!evolutionUrl || !apiKey) throw new Error('Missing Evolution Config');

    // Verify group exists in database
    const groupRes = await db.query(
      'SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1',
      [groupJid]
    );

    if (groupRes.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found in database. Sync groups first.' });
    }

    const groupId = groupRes.rows[0].group_id;

    // METHOD 1: Try findMessages endpoint (POST)
    console.log('🔍 Attempting Evolution API: POST /message/findMessages...');
    
    let messages = [];
    try {
      const response = await axios.post(
        `${evolutionUrl}/message/findMessages/${finalInstanceName}`,
        {
          groupJid: groupJid,
          limit: messageLimit
        },
        {
          headers: { 
            'Content-Type': 'application/json',
            'apikey': apiKey 
          }
        }
      );

      messages = response.data?.messages || response.data || [];
      console.log(`✅ Method 1 success: ${messages.length} messages fetched`);

    } catch (err) {
      // METHOD 2: Fallback to fetch all messages and filter client-side
      console.log('⚠️ Method 1 failed, trying fallback: GET /message/fetch...');
      
      try {
        const fallbackResponse = await axios.get(
          `${evolutionUrl}/message/fetch/${finalInstanceName}`,
          {
            headers: { 'apikey': apiKey },
            params: { limit: 500 } // Fetch more for filtering
          }
        );

        const allMessages = fallbackResponse.data?.messages || fallbackResponse.data || [];
        
        // Client-side filter by groupJid
        messages = allMessages.filter(msg => {
          const remoteJid = msg.key?.remoteJid;
          return remoteJid === groupJid;
        }).slice(0, messageLimit);

        console.log(`✅ Method 2 success: Filtered ${messages.length}/${allMessages.length} messages for group`);

      } catch (fallbackErr) {
        throw new Error(`Both methods failed. Error: ${fallbackErr.message}`);
      }
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ 
        success: true, 
        saved: 0, 
        fetched: 0,
        message: 'No messages found for this group' 
      });
    }

    console.log(`📦 Processing ${messages.length} messages...`);

    let savedCount = 0;
    let skippedCount = 0;

    for (const msg of messages) {
      try {
        const key = msg.key || {};
        const messageId = key.id;
        
        if (!messageId) {
          skippedCount++;
          continue;
        }

        const isFromMe = key.fromMe;
        const senderJid = isFromMe ? 'ME' : (key.participant || key.remoteJid);
        const timestamp = msg.messageTimestamp || Math.floor(Date.now() / 1000);

        // Extract message body
        let body = '';
        if (msg.message?.conversation) {
          body = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          body = msg.message.extendedTextMessage.text;
        } else if (msg.message?.imageMessage?.caption) {
          body = `[Image] ${msg.message.imageMessage.caption}`;
        } else if (msg.message?.videoMessage?.caption) {
          body = `[Video] ${msg.message.videoMessage.caption}`;
        } else if (msg.message?.documentMessage) {
          body = '[Document]';
        } else {
          body = '[Media/System Message]';
        }

        // Skip empty or very short messages
        if (!body || body.length < 2) {
          skippedCount++;
          continue;
        }

        // Ensure sender exists in members table
        await db.query(`
          INSERT INTO crm.wa_members (whatsapp_id, display_name)
          VALUES ($1, $2)
          ON CONFLICT (whatsapp_id) DO NOTHING
        `, [senderJid, msg.pushName || 'Unknown']);

        // Get member_id
        const memberRes = await db.query(
          'SELECT member_id FROM crm.wa_members WHERE whatsapp_id = $1',
          [senderJid]
        );

        if (memberRes.rows.length === 0) {
          skippedCount++;
          continue;
        }

        const memberId = memberRes.rows[0].member_id;

        // Insert message
        const insertResult = await db.query(`
          INSERT INTO crm.wa_messages (
            whatsapp_message_id, group_id, sender_id, message_content, 
            created_at, has_media, media_type, is_from_me
          ) VALUES ($1, $2, $3, $4, TO_TIMESTAMP($5), $6, $7, $8)
          ON CONFLICT (whatsapp_message_id) DO NOTHING
          RETURNING message_id
        `, [
          messageId,
          groupId,
          memberId,
          body,
          timestamp,
          msg.message?.imageMessage || msg.message?.videoMessage ? true : false,
          msg.message?.imageMessage ? 'image' : (msg.message?.videoMessage ? 'video' : 'text'),
          isFromMe
        ]);

        if (insertResult.rowCount > 0) {
          savedCount++;
        } else {
          skippedCount++; // Duplicate message
        }

      } catch (msgError) {
        console.error('Failed to save message:', msgError.message);
        skippedCount++;
      }
    }

    console.log(`✅ Message sync complete: ${savedCount} saved, ${skippedCount} skipped`);

    res.json({
      success: true,
      totalFetched: messages.length,
      saved: savedCount,
      skipped: skippedCount
    });

  } catch (error) {
    console.error('❌ Message sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;
