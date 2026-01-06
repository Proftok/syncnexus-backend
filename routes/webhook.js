const express = require('express');
const router = express.Router();
const db = require('../config/db');

// PROCESS INCOMING WEBHOOKS
router.post('/evolution', async (req, res) => {
    try {
        const { type, data, event } = req.body; // Check for 'event' too
        const eventType = type || event; // Evolution sometimes sends 'event'
        console.log(`⚡ Webhook received: ${eventType}`);
        if (!eventType) console.log('DEBUG BODY:', JSON.stringify(req.body, null, 2));

        if (eventType === 'messages.upsert') {
            const message = data.data;
            if (!message) return res.status(200).send('No data');

            // EXTRACT DATA
            const key = message.key || {};
            const isFromMe = key.fromMe;
            const remoteJid = key.remoteJid; // Group or user JID
            const senderJid = isFromMe ? 'DATA_SYNC_HOST' : (key.participant || remoteJid);
            const pushName = message.pushName || 'Unknown';
            const timestamp = message.messageTimestamp || Math.floor(Date.now() / 1000);

            // EXTRACT BODY
            let body = '';
            if (message.message?.conversation) body = message.message.conversation;
            else if (message.message?.extendedTextMessage?.text) body = message.message.extendedTextMessage.text;
            else body = '[Media/Unknown]';

            // UPSERT SENDER (Ensure member exists)
            // Use a simplified query to minimal overhead
            await db.query(`
                INSERT INTO crm.wa_members (whatsapp_id, display_name)
                VALUES ($1, $2)
                ON CONFLICT (whatsapp_id) DO NOTHING
            `, [senderJid, pushName]);

            // RESOLVE IDS
            const groupRes = await db.query('SELECT group_id FROM crm.wa_groups WHERE whatsapp_group_id = $1', [remoteJid]);
            const memberRes = await db.query('SELECT member_id FROM crm.wa_members WHERE whatsapp_id = $1', [senderJid]);

            if (groupRes.rows.length > 0 && memberRes.rows.length > 0) {
                const groupId = groupRes.rows[0].group_id;
                const memberId = memberRes.rows[0].member_id;

                // INSERT MESSAGE
            await db.query(`
  INSERT INTO crm.wa_messages (
    whatsapp_message_id, group_id, sender_id, message_content, timestamp, created_at, has_media, media_type
  ) VALUES ($1, $2, $3, $4, TO_TIMESTAMP($5), TO_TIMESTAMP($5), $6, $7)
  ON CONFLICT (whatsapp_message_id) DO NOTHING
`, [key.id, groupId, memberId, body, timestamp, false, 'text']);


                console.log(`✅ Saved message from ${pushName} in ${remoteJid}`);
            } else {
                console.log(`⚠️ Skipped message: Group or Member not found in DB (${remoteJid})`);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(200).send('Error'); // Prevent retries loop from Evolution
    }
});

module.exports = router;
