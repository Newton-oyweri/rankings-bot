const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase
const SUPABASE_URL = 'https://bkmdutrvxugyrwthmtjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4IGJpyudIfDqJGKssifbrg_Lt4RYh1p';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let isSending = false;

async function sendAnnouncement() {
  console.log('Connecting to WhatsApp...');

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
      if (isSending) return;
      isSending = true;

      console.log('✅ WhatsApp connected!');
      console.log('⏳ Waiting 5 seconds for connection to stabilize...');

      // Wait 5 seconds to ensure USync device keys are warmed up
      await new Promise((resolve) => setTimeout(resolve, 5000));

      try {
        console.log('\n🔍 Fetching active subscribers from Supabase...');
        const { data: subscribers, error } = await supabase
          .from('group_subscribers')
          .select('jid, phone_number')
          .eq('opted_in', true);

        if (error) {
          console.error('❌ Error fetching from Supabase:', error.message);
          process.exit(1);
        }

        if (!subscribers || subscribers.length === 0) {
          console.log('ℹ️ No active subscribers found in database.');
          process.exit(0);
        }

        console.log(`📢 Found ${subscribers.length} subscriber(s). Starting broadcast...\n`);

        const updateMessage = 'Hello, this is an update 2';

        for (let i = 0; i < subscribers.length; i++) {
          const sub = subscribers[i];
          let targetJid = sub.jid;

          // Convert any remaining @lid JIDs to standard phone JIDs if possible
          if (targetJid.endsWith('@lid')) {
            const cleanPhone = sub.phone_number.replace(/\D/g, '');
            if (cleanPhone) {
              targetJid = `${cleanPhone}@s.whatsapp.net`;
            }
          }

          console.log(`[${i + 1}/${subscribers.length}] Sending to ${targetJid}...`);

          try {
            await sock.sendMessage(targetJid, { text: updateMessage });
            console.log(`✅ Message delivered successfully!`);
          } catch (sendErr) {
            console.error(`❌ Failed to send to ${targetJid}:`, sendErr.message || sendErr);
          }

          // Safe delay between messages to prevent rate-limiting
          if (i < subscribers.length - 1) {
            await new Promise((res) => setTimeout(res, 3000));
          }
        }

        console.log('\n🎉 Update broadcast complete!');
      } catch (err) {
        console.error('❌ Broadcast error:', err);
      } finally {
        setTimeout(() => {
          process.exit(0);
        }, 3000);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && !isSending) {
        console.log('Reconnecting...');
        sendAnnouncement();
      } else if (!shouldReconnect) {
        console.log('Logged out.');
      }
    }
  });
}

sendAnnouncement().catch(console.error);