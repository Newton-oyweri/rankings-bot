const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');

// Supabase Setup
const SUPABASE_URL = 'https://bkmdutrvxugyrwthmtjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4IGJpyudIfDqJGKssifbrg_Lt4RYh1p';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function syncGroupContactsToDb() {
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

    if (connection === 'open') {
      console.log('✅ WhatsApp connected!\n');

      try {
        console.log('📦 Fetching all groups you are in...');
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);

        console.log(`Found ${groupList.length} groups. Extracting member contacts...\n`);

        const extractedMap = new Map(); // Store unique contacts by phone number

        for (const group of groupList) {
          console.log(`🔍 Processing: "${group.subject}" (${group.participants.length} members)`);

          for (const p of group.participants) {
            let phoneJid = null;

            // Case A: Direct phone JID (@s.whatsapp.net)
            if (p.id.endsWith('@s.whatsapp.net')) {
              phoneJid = p.id;
            } 
            // Case B: Convert LID to phone JID if Baileys mapped the alternate JID
            else if (p.phoneNumber) {
              const cleanDigits = p.phoneNumber.replace(/\D/g, '');
              if (cleanDigits) phoneJid = `${cleanDigits}@s.whatsapp.net`;
            }
            // Case C: Check internal participant object properties
            else if (p.jid && p.jid.endsWith('@s.whatsapp.net')) {
              phoneJid = p.jid;
            }

            if (phoneJid) {
              const digits = phoneJid.split('@')[0];
              const formattedPhone = `+${digits}`;

              extractedMap.set(phoneJid, {
                phone_number: formattedPhone,
                jid: phoneJid,
                opted_in: false,
                updated_at: new Date().toISOString()
              });
            }
          }
        }

        const allSubscribers = Array.from(extractedMap.values());

        console.log(`\n====================================`);
        console.log(`📊 Valid Phone Contacts Found: ${allSubscribers.length}`);
        console.log(`====================================\n`);

        if (allSubscribers.length > 0) {
          console.log('💾 Inserting into Supabase database...');

          const BATCH_SIZE = 100;
          let insertedCount = 0;

          for (let i = 0; i < allSubscribers.length; i += BATCH_SIZE) {
            const batch = allSubscribers.slice(i, i + BATCH_SIZE);

            const { error } = await supabase
              .from('group_subscribers')
              .upsert(batch, { onConflict: 'jid', ignoreDuplicates: true });

            if (error) {
              console.error(`❌ Batch error:`, error.message);
            } else {
              insertedCount += batch.length;
              console.log(`✅ Upserted batch (${insertedCount}/${allSubscribers.length})`);
            }
          }

          console.log('\n🎉 Successfully synced group contacts to Supabase!');
        } else {
          console.log('⚠️ Group metadata only contains hidden @lid IDs.');
          console.log('👉 Best alternative: As users message your bot (index.js), their real phone JIDs are automatically resolved and saved to Supabase.');
        }

      } catch (error) {
        console.error('❌ Error during sync process:', error);
      } finally {
        setTimeout(() => process.exit(0), 3000);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        syncGroupContactsToDb();
      }
    }
  });
}

syncGroupContactsToDb().catch(console.error);