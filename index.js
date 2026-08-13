const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase
const SUPABASE_URL = 'https://bkmdutrvxugyrwthmtjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4IGJpyudIfDqJGKssifbrg_Lt4RYh1p';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 2. Initialize Minimal Express Web Server
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Sophia AI Bot is running!'));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

async function startBot() {
  console.log('Starting bot...');

  const { state, saveCreds } = await useMultiFileAuthState('./session_auth');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nSCAN THIS QR CODE:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected and ready for Opt-In testing!\n');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed.');
      if (shouldReconnect) startBot();
    }
  });

  // 3. Listen for incoming messages & process opt-ins
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const rawJid = msg.key.remoteJid;
      let targetJid = rawJid;

      // Extract real phone JID if message originated from an @lid
      if (rawJid.endsWith('@lid')) {
        const altJid = msg.key.participant || msg.key.remoteJidAlt;
        if (altJid && altJid.endsWith('@s.whatsapp.net')) {
          targetJid = altJid;
        }
      }

      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim().toLowerCase();

      console.log(`📩 Received message from ${rawJid} (Mapped to: ${targetJid}): "${text}"`);

      // Extract raw digits for phone property
      const rawNumber = targetJid.split('@')[0];
      const phoneNumber = targetJid.endsWith('@s.whatsapp.net') ? `+${rawNumber}` : rawNumber;

      // OPTION A: User accepts the opt-in
      if (['1', 'yes', 'start', 'subscribe'].includes(text)) {
        try {
          // Upsert using 'jid' as unique key
          const { data, error } = await supabase
            .from('group_subscribers')
            .upsert(
              {
                phone_number: phoneNumber,
                jid: targetJid,
                opted_in: true,
                updated_at: new Date().toISOString()
              },
              { onConflict: 'jid' }
            )
            .select();

          if (error) {
            console.error('❌ Supabase Insert Error:', error.message);
            await sock.sendMessage(targetJid, {
              text: '⚠️ Something went wrong saving your subscription. Please try again later.'
            });
          } else {
            console.log('✅ Saved subscriber to Supabase:', data);
            await sock.sendMessage(targetJid, {
              text: '🎉 Thank you! You have successfully subscribed to eFootball Kenya announcements. You will receive updates directly here!'
            });
          }
        } catch (err) {
          console.error('❌ Database error:', err);
        }
      } 
      // OPTION B: User declines
      else if (['2', 'no', 'stop', 'unsubscribe'].includes(text)) {
        try {
          await supabase
            .from('group_subscribers')
            .upsert(
              {
                phone_number: phoneNumber,
                jid: targetJid,
                opted_in: false,
                updated_at: new Date().toISOString()
              },
              { onConflict: 'jid' }
            );

          await sock.sendMessage(targetJid, {
            text: '👍 You have opted out. You won\'t receive any announcement messages.'
          });
        } catch (err) {
          console.error('❌ Database error:', err);
        }
      } 
      // OPTION C: First-time or general prompt
      else {
        const welcomeMessage = 
          `👋 Hi there!\n\n` +
          `Would you like to receive eFootball Kenya announcements directly in your inbox?\n\n` +
          `Reply with:\n` +
          `1️⃣ *YES* - to subscribe to announcements\n` +
          `2️⃣ *NO* - to decline\n\n` +
          `_Powered by Skyla AI_`;

        await sock.sendMessage(targetJid, { text: welcomeMessage });
      }
    }
  });
}

startBot().catch(console.error);