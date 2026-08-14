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

const PHONE_NUMBER = process.env.PHONE_NUMBER || '254141899116';

// 2. Initialize Express Web Server (For Render Uptime)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Sophia AI Bot v2 (Distributed Engine) is active!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// Configuration Constants
const BATCH_SIZE = 10;                     // Contacts per mini-batch
const TOTAL_BATCHES = 5;                   // 5 batches * 10 = 50 total messages / day
const MIN_DELAY_SEC = 30;                  // Min delay between individual contacts
const MAX_DELAY_SEC = 60;                  // Max delay between individual contacts
const INTER_BATCH_PAUSE_HOURS = 3;         // Wait time between mini-batches
const OVERNIGHT_REST_HOURS = 12;           // Rest time after completing all 5 batches

// Spin-tax Message Templates
const INVITE_TEMPLATES = [
  `eFootball Rankings is now on WhatsApp!\n\nReply 1 to subscribe for official announcements and updates.`,
  `Hey gamer! Get official eFootball Kenya tournament updates directly on WhatsApp.\n\nReply 1 to opt-in for announcements.`,
  `Official eFootball Kenya WhatsApp announcements are live.\n\nReply 1 to subscribe to rankings & match news.`
];

let isWorkerRunning = false;

function getRandomDelay(minSeconds, maxSeconds) {
  const min = minSeconds * 1000;
  const max = maxSeconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper: Send & Log Messages
async function sendAndLogMessage(sock, targetJid, phoneNumber, text) {
  try {
    await sock.sendMessage(targetJid, { text });

    await supabase.from('message_logs').insert({
      recipient_jid: targetJid,
      phone_number: phoneNumber,
      direction: 'OUTBOUND',
      message_text: text,
      status: 'SENT'
    });
    return true;
  } catch (err) {
    console.error(`❌ Failed send to ${targetJid}:`, err.message || err);

    await supabase.from('message_logs').insert({
      recipient_jid: targetJid,
      phone_number: phoneNumber,
      direction: 'OUTBOUND',
      message_text: text,
      status: 'FAILED'
    });
    return false;
  }
}

async function startBot() {
  console.log('🚀 Starting Sophia AI Bot v2...');

  const { state, saveCreds } = await useMultiFileAuthState('./session_auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    printQRInTerminal: false
  });

  // Pairing Code Request
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

  // Connection Manager
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected successfully!');

      if (!isWorkerRunning) {
        isWorkerRunning = true;
        runDripWorker(sock);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('⚠️ Connection closed.');
      isWorkerRunning = false;

      if (shouldReconnect) {
        console.log('Reconnecting...');
        startBot();
      } else {
        console.log('❌ Session logged out. Please re-pair your account.');
      }
    }
  });

  // =========================================================
  // 📥 INBOUND LISTENER (Handles Live & Missed Offline Unreads)
  // =========================================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      // Ignore messages sent more than 4 hours ago (14400 seconds)
      const msgTimestamp = msg.messageTimestamp;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (msgTimestamp && (nowSeconds - msgTimestamp > 14400)) {
        continue;
      }

      const rawJid = msg.key.remoteJid;
      if (rawJid.endsWith('@g.us')) continue; // Ignore groups

      let targetJid = rawJid;
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

      const rawNumber = targetJid.split('@')[0];
      const phoneNumber = targetJid.endsWith('@s.whatsapp.net') ? `+${rawNumber}` : rawNumber;

      console.log(`📥 Inbound from ${targetJid}: "${text}"`);

      // Log Inbound Message
      try {
        await supabase.from('message_logs').insert({
          recipient_jid: targetJid,
          phone_number: phoneNumber,
          direction: 'INBOUND',
          message_text: text,
          status: 'RECEIVED'
        });
      } catch (logErr) {
        console.error('Logging error:', logErr.message);
      }

      // OPTION 1: Subscribe
      if (['1', 'yes', 'start', 'subscribe'].includes(text)) {
        try {
          await supabase
            .from('group_subscribers')
            .upsert(
              {
                phone_number: phoneNumber,
                jid: targetJid,
                opted_in: true,
                updated_at: new Date().toISOString()
              },
              { onConflict: 'jid' }
            );

          const successMsg = 
            `*Subscription Confirmed!*\n\n` +
            `You have successfully subscribed to *eFootball Kenya* announcements.\n\n` +
            `Website: https://efootballkenyaleague.website/\n\n` +
            `Reply *2* or *STOP* at any time to unsubscribe.`;

          await sendAndLogMessage(sock, targetJid, phoneNumber, successMsg);
          console.log(`✅ Subscribed user: ${targetJid}`);
        } catch (err) {
          console.error('Subscription error:', err);
        }
      } 
      // OPTION 2: Unsubscribe
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

          const optOutMsg = `You have opted out. You will no longer receive updates. Reply *1* anytime to re-subscribe.`;
          await sendAndLogMessage(sock, targetJid, phoneNumber, optOutMsg);
          console.log(`🛑 Opted-out user: ${targetJid}`);
        } catch (err) {
          console.error('Opt-out error:', err);
        }
      } 
      // OPTION 3: General Query / Welcome Menu
      else {
        const { data: subscriber } = await supabase
          .from('group_subscribers')
          .select('opted_in')
          .eq('jid', targetJid)
          .maybeSingle();

        const isOptedIn = subscriber ? subscriber.opted_in : false;

        if (isOptedIn) {
          const infoMessage = 
            `*efootball Kenya league*\n\n` +
            `Stay connected with rankings & tournaments:\n` +
            `https://efootballkenyaleague.website/\n\n` +
            `Reply *1* for updates | Reply *2* to unsubscribe`;
          await sendAndLogMessage(sock, targetJid, phoneNumber, infoMessage);
        } else {
          const welcomeMessage = 
            `*Welcome to eFootball Kenya*\n\n` +
            `Would you like to receive official tournament announcements and rankings directly in your inbox?\n\n` +
            `Reply:\n` +
            `1. *YES* - Subscribe\n` +
            `2. *NO* - Decline`;
          await sendAndLogMessage(sock, targetJid, phoneNumber, welcomeMessage);
        }
      }
    }
  });
}

// =========================================================
// 📢 DISTRIBUTED OUTBOUND DRIP WORKER (5 Batches of 10 / Day)
// =========================================================
async function runDripWorker(sock) {
  console.log('\n🔄 Distributed Drip Worker initialized.');

  while (isWorkerRunning) {
    try {
      let totalSentToday = 0;

      for (let batch = 1; batch <= TOTAL_BATCHES; batch++) {
        if (!isWorkerRunning) break;

        // Fetch contacts who haven't been invited yet
        const { data: subscribers, error } = await supabase
          .from('group_subscribers')
          .select('id, jid, phone_number')
          .eq('opted_in', false)
          .eq('invite_sent', false)
          .order('id', { ascending: true })
          .limit(BATCH_SIZE);

        if (error) {
          console.error('❌ Supabase fetch error:', error.message);
          await new Promise((res) => setTimeout(res, 60000));
          continue;
        }

        if (!subscribers || subscribers.length === 0) {
          console.log('ℹ️ No uninvited contacts found in database. Checking again in 1 hour...');
          await new Promise((res) => setTimeout(res, 60 * 60 * 1000));
          break; 
        }

        console.log(`\n==================================================`);
        console.log(`📢 STARTING BATCH ${batch}/${TOTAL_BATCHES} (${subscribers.length} new contacts)`);
        console.log(`==================================================\n`);

        for (let i = 0; i < subscribers.length; i++) {
          if (!isWorkerRunning) break;

          const sub = subscribers[i];
          let targetJid = sub.jid;

          if (targetJid.endsWith('@lid')) {
            const cleanPhone = sub.phone_number ? sub.phone_number.replace(/\D/g, '') : '';
            if (cleanPhone) {
              targetJid = `${cleanPhone}@s.whatsapp.net`;
            }
          }

          const messageText = INVITE_TEMPLATES[Math.floor(Math.random() * INVITE_TEMPLATES.length)];

          console.log(`[Batch ${batch} - ${i + 1}/${subscribers.length}] Sending invite to ID ${sub.id} (${targetJid})...`);
          const success = await sendAndLogMessage(sock, targetJid, sub.phone_number, messageText);

          if (success) {
            totalSentToday++;

            // Update database so this user is marked as invited
            await supabase
              .from('group_subscribers')
              .update({
                invite_sent: true,
                updated_at: new Date().toISOString()
              })
              .eq('id', sub.id);
          }

          // Delay between individual messages in the same batch (30-60s)
          if (i < subscribers.length - 1) {
            const delayMs = getRandomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
            console.log(`⏳ Pacing pause: Waiting ${(delayMs / 1000).toFixed(1)}s...`);
            await new Promise((res) => setTimeout(res, delayMs));
          }
        }

        // Pause between mini-batches (3 hours) except after the last batch
        if (batch < TOTAL_BATCHES) {
          console.log(`\n⏸️ Batch ${batch} complete. Resting for ${INTER_BATCH_PAUSE_HOURS} hours before Batch ${batch + 1}...`);
          await new Promise((res) => setTimeout(res, INTER_BATCH_PAUSE_HOURS * 60 * 60 * 1000));
        }
      }

      console.log(`\n==================================================`);
      console.log(`🎉 ALL DAILY BATCHES COMPLETE (${totalSentToday} invites delivered today).`);
      console.log(`😴 Entering overnight rest for ${OVERNIGHT_REST_HOURS} hours...`);
      console.log(`==================================================\n`);

      // Overnight rest before starting next day's campaign
      await new Promise((res) => setTimeout(res, OVERNIGHT_REST_HOURS * 60 * 60 * 1000));

    } catch (err) {
      console.error('❌ Drip worker runtime error:', err);
      await new Promise((res) => setTimeout(res, 5 * 60 * 1000));
    }
  }
}

startBot().catch(console.error);