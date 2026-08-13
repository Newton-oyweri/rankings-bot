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

const BATCH_SIZE = 100;
const MAX_BATCH_RETRIES = 3;

// Best-effort: Baileys keeps a local LID <-> phone-number mapping store for
// contacts it has managed to resolve (e.g. from message traffic). Not every
// hidden @lid participant will be in it — if WhatsApp never told this
// session their real number, there's nothing to look up.
async function resolveLidToPhoneJid(sock, lidJid) {
  try {
    const mapper = sock.signalRepository?.lidMapping;
    if (mapper?.getPNForLID) {
      const pn = await mapper.getPNForLID(lidJid);
      if (pn) {
        const digits = pn.split('@')[0].replace(/\D/g, '');
        if (digits) return `${digits}@s.whatsapp.net`;
      }
    }
  } catch (err) {
    // No local mapping available for this contact — that's expected for
    // many hidden participants, not an error worth failing the sync over.
  }
  return null;
}

function extractDirectPhoneJid(p) {
  if (p.id?.endsWith('@s.whatsapp.net')) return p.id;
  if (p.phoneNumber) {
    const digits = p.phoneNumber.replace(/\D/g, '');
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  if (p.jid?.endsWith('@s.whatsapp.net')) return p.jid;
  return null;
}

async function upsertBatchWithRetry(batch, batchLabel) {
  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    const { error } = await supabase
      .from('group_subscribers')
      .upsert(batch, { onConflict: 'jid', ignoreDuplicates: true });

    if (!error) return { ok: true };

    console.error(`❌ ${batchLabel} attempt ${attempt}/${MAX_BATCH_RETRIES} failed:`, error.message);
    if (attempt < MAX_BATCH_RETRIES) {
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    } else {
      return { ok: false, error };
    }
  }
}

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
        console.log('📋 Loading already-synced jids from Supabase...');
        const { data: existingRows, error: existingErr } = await supabase
          .from('group_subscribers')
          .select('jid');

        if (existingErr) {
          console.error('❌ Could not load existing jids (continuing anyway):', existingErr.message);
        }
        const alreadySynced = new Set((existingRows || []).map((r) => r.jid));
        console.log(`   ${alreadySynced.size} already in the database.\n`);

        console.log('📦 Fetching all groups you are in...');
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);
        console.log(`Found ${groupList.length} groups. Extracting member contacts...\n`);

        const extractedMap = new Map(); // unique resolved contacts by phone jid
        const unresolvedLids = new Set(); // hidden participants we couldn't map
        let totalParticipants = 0;

        for (const group of groupList) {
          console.log(`🔍 Processing: "${group.subject}" (${group.participants.length} members)`);
          totalParticipants += group.participants.length;

          for (const p of group.participants) {
            let phoneJid = extractDirectPhoneJid(p);

            // Hidden/@lid-only participant — try the local mapping store
            if (!phoneJid && p.id?.endsWith('@lid')) {
              phoneJid = await resolveLidToPhoneJid(sock, p.id);
              if (!phoneJid) {
                unresolvedLids.add(p.id);
                continue;
              }
            }

            if (!phoneJid) continue;

            const digits = phoneJid.split('@')[0];
            extractedMap.set(phoneJid, {
              phone_number: `+${digits}`,
              jid: phoneJid,
              opted_in: false,
              updated_at: new Date().toISOString()
            });
          }
        }

        const allContacts = Array.from(extractedMap.values());
        const newContacts = allContacts.filter((c) => !alreadySynced.has(c.jid));

        console.log(`\n====================================`);
        console.log(`📊 Sync summary`);
        console.log(`   Participants scanned:     ${totalParticipants}`);
        console.log(`   Resolved phone contacts:  ${allContacts.length}`);
        console.log(`   Already in database:      ${allContacts.length - newContacts.length}`);
        console.log(`   New contacts to insert:   ${newContacts.length}`);
        console.log(`   Unresolved hidden (@lid): ${unresolvedLids.size}`);
        console.log(`====================================\n`);

        if (newContacts.length > 0) {
          console.log('💾 Upserting new contacts into Supabase...');

          const failedBatches = [];
          let insertedCount = 0;

          for (let i = 0; i < newContacts.length; i += BATCH_SIZE) {
            const batch = newContacts.slice(i, i + BATCH_SIZE);
            const label = `Batch ${Math.floor(i / BATCH_SIZE) + 1}`;
            const result = await upsertBatchWithRetry(batch, label);

            if (result.ok) {
              insertedCount += batch.length;
              console.log(`✅ ${label} upserted (${insertedCount}/${newContacts.length})`);
            } else {
              failedBatches.push(...batch.map((c) => c.jid));
            }
          }

          console.log(`\n🎉 Synced ${insertedCount}/${newContacts.length} new contacts.`);
          if (failedBatches.length > 0) {
            console.log(`⚠️ ${failedBatches.length} contact(s) failed after ${MAX_BATCH_RETRIES} retries — re-run the script to retry them:`);
            console.log(failedBatches.join(', '));
          }
        } else {
          console.log('ℹ️ No new contacts to add — everyone resolvable is already synced.');
        }

        if (unresolvedLids.size > 0) {
          console.log(`\n👉 ${unresolvedLids.size} group member(s) use hidden IDs WhatsApp hasn't shared a number for in this session.`);
          console.log('   These get resolved automatically once that person messages the bot directly (index.js already handles that).');
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