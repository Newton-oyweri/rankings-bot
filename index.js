const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bkmdutrvxugyrwthmtjb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_4IGJpyudIfDqJGKssifbrg_Lt4RYh1p';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Phone number for pairing code (without '+' or spaces, e.g., '254141899116')
const PHONE_NUMBER = process.env.PHONE_NUMBER || '254141899116';

// 2. Initialize Minimal Express Web Server
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Sophia AI Bot is running!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

async function startBot() {
  console.log('Starting bot...');

  const { state, saveCreds } = await useMultiFileAuthState('./session_auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    printQRInTerminal: false // Disabled QR code in terminal
  });

  // Request Pairing Code if session is not authenticated yet
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n==================================================');
        console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log('==================================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 4000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('WhatsApp connected and ready for Opt-In testing!\n');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed.');
      if (shouldReconnect) startBot();
    }
  });

  // Helper function to send and log messages automatically
  async function sendAndLogMessage(targetJid, phoneNumber, text) {
    try {
      await sock.sendMessage(targetJid, { text });
      
      // Log outbound message in Supabase
      await supabase.from('message_logs').insert({
        recipient_jid: targetJid,
        phone_number: phoneNumber,
        direction: 'OUTBOUND',
        message_text: text,
        status: 'SENT'
      });
    } catch (err) {
      console.error(`Failed to send message to ${targetJid}:`, err);
    }
  }

  // 3. Listen for incoming messages & process opt-ins
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const rawJid = msg.key.remoteJid;

      // 🚫 IGNORE GROUP MESSAGES
      if (rawJid.endsWith('@g.us')) continue;

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

      console.log(`Received message from ${rawJid} (Mapped to: ${targetJid}): "${text}"`);

      // Extract raw digits for phone property
      const rawNumber = targetJid.split('@')[0];
      const phoneNumber = targetJid.endsWith('@s.whatsapp.net') ? `+${rawNumber}` : rawNumber;

      // Log inbound message in Supabase
      try {
        await supabase.from('message_logs').insert({
          recipient_jid: targetJid,
          phone_number: phoneNumber,
          direction: 'INBOUND',
          message_text: text,
          status: 'RECEIVED'
        });
      } catch (logErr) {
        console.error('Failed to log inbound message:', logErr.message);
      }

      // OPTION A: User accepts the opt-in
      if (['1', 'yes', 'start', 'subscribe'].includes(text)) {
        try {
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
            console.error('Supabase Insert Error:', error.message);
            await sendAndLogMessage(targetJid, phoneNumber, 'Something went wrong saving your subscription. Please try again later.');
          } else {
            console.log('Saved subscriber to Supabase:', data);
            const successMsg = 
              `*Subscription Confirmed!*\n\n` +
              `You have successfully subscribed to *eFootball Kenya* announcements. You will receive news and updates directly in your inbox.\n\n` +
              `Reply *2* or *STOP* at any time to unsubscribe.`;

            await sendAndLogMessage(targetJid, phoneNumber, successMsg);
          }
        } catch (err) {
          console.error('Database error:', err);
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

          const optOutMsg = `You have opted out. You will no longer receive announcement updates. Reply *1* anytime to re-subscribe.`;
          await sendAndLogMessage(targetJid, phoneNumber, optOutMsg);
        } catch (err) {
          console.error('Database error:', err);
        }
      } 
      // OPTION C: Handle General Direct Messages
      else {
        // Query user subscription state from Supabase
        const { data: subscriber } = await supabase
          .from('group_subscribers')
          .select('opted_in')
          .eq('jid', targetJid)
          .maybeSingle();

        const isOptedIn = subscriber ? subscriber.opted_in : false;

        if (isOptedIn) {
          // Response for ALREADY OPTED-IN Users
          const infoMessage = 
            `*No updates from rankings eFootball yet.*\n\n` +
            `Stay connected with the latest rankings and tournament details:\n\n` +
            `*Main Website*\n` +
            `https://efootballkenyaleague.website/\n\n` +
            `*View Fixtures & Results*\n` +
            `https://efootballkenyaleague.website/fixtures-and-results\n\n` +
            `*Register for Tournament*\n` +
            `https://efootballkenyaleague.website/register\n\n` +
            `*Ongoing Tournaments*\n` +
            `https://efootballkenyaleague.website/activetournaments\n\n` +
            `─────────────\n` +
            `*Manage Subscription:*\n` +
            `Reply *1* for announcements | Reply *2* to unsubscribe\n\n` +
            `_Powered by Skyla AI_`;

          await sendAndLogMessage(targetJid, phoneNumber, infoMessage);
        } else {
          // Response for NOT OPTED-IN Users
          const welcomeMessage = 
            `*Welcome to eFootball Kenya*\n\n` +
            `Would you like to receive official tournament announcements and rankings directly in your inbox?\n\n` +
            `Reply with:\n` +
            `1. *YES* - Subscribe to announcements\n` +
            `2. *NO* - Decline\n\n` +
            `_Powered by Skyla AI_`;

          await sendAndLogMessage(targetJid, phoneNumber, welcomeMessage);
        }
      }
    }
  });
}

startBot().catch(console.error);