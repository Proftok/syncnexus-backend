const express = require('express');
const router = express.Router();
const db = require('../config/db');
const OpenAI = require('openai');

// CONFIG
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-mini";

// INIT OPENAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// ENRICH PROFILE
router.post('/enrich', async (req, res) => {
    try {
        const { memberId, forceDeep } = req.body;

        // Fetch Member & Messages
        const memberRes = await db.query(
            'SELECT * FROM crm.wa_members WHERE member_id = $1',
            [memberId]
        );

        if (memberRes.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const member = memberRes.rows[0];
        const msgRes = await db.query(
            'SELECT message_content FROM crm.wa_messages WHERE sender_id = $1 ORDER BY created_at DESC LIMIT 50',
            [memberId]
        );

        const messages = msgRes.rows.map(m => m.message_content).join('\n');

        if (!messages && !forceDeep) {
            return res.json({ status: 'skipped', reason: 'No messages' });
        }

        const systemPrompt = `You are an expert Analyst.
Analyze the provided WhatsApp message history for: ${member.display_name}.
Infer their Job Role, Industry, and Influence Level.
Return JSON only with fields: role, summary, score.`;

        const userPrompt = `MESSAGES:\n${messages.substring(0, 5000)}`;

        const completion = await openai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" }
        });

        const content = completion.choices[0].message.content;
        const data = JSON.parse(content);

        // Save to DB
        await db.query(`
      UPDATE crm.wa_members
      SET job_title = $1,
          chat_profile_summary = $2,
          enrichment_priority = $3,
          last_active_at = NOW()
      WHERE member_id = $4
    `, [data.role || 'Unknown', data.summary || '', data.score || 0, memberId]);

        res.json({ success: true, data });
    } catch (error) {
        console.error('AI Enrichment Error (OpenAI):', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
