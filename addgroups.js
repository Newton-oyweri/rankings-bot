const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Safety delay configuration (20 - 45 seconds between joins)
const MIN_DELAY_MS = 20000;
const MAX_DELAY_MS = 45000;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

// Extracts 20-25 character invite codes from text
function extractInviteCodes(text) {
  if (!text) return [];
  const regex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,25})/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

const processedCodes = new Set();

async function processInviteCode(sock, code, existingGroupJids = new Set()) {
  if (processedCodes.has(code)) return;
  processedCodes.add(code);

  try {
    // Check invite details without joining
    const info = await sock.groupGetInviteInfo(code);

    if (!info || !info.id) {
      console.log(`⚠️ Invite link invalid or expired: ${code}`);
      return;
    }

    const groupJid = `${info.id}@g.us`;

    if (existingGroupJids.has(groupJid)) {
      console.log(`ℹ️ Already in group: "${info.subject}". Skipping.`);
      return;
    }

    console.log(`🎯 Discovered Group: "${info.subject}" (${info.size || '?'} members)`);
    console.log(`🤝 Joining...`);

    const joinedJid = await sock.groupAcceptInvite(code);
    console.log(`🎉 Successfully joined "${info.subject}"!`);

    existingGroupJids.add(joinedJid || groupJid);

  } catch (err) {
    console.error(`❌ Failed to join group [${code}]:`, err.message || err);
  }
}

async function startAddGroups() {
  console.log('🚀 Starting Dedicated Group Discovery & Auto-Joiner...');

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
      console.log('✅ Connected to WhatsApp!\n');

      try {
        // Fetch current groups to avoid re-joining
        const currentGroups = await sock.groupFetchAllParticipating();
        const existingGroupJids = new Set(Object.keys(currentGroups));
        console.log(`📋 Account is currently in ${existingGroupJids.size} group(s).`);

        const discoveredCodes = new Set();

        // 1. Scan current group descriptions for invite links
        for (const group of Object.values(currentGroups)) {
          if (group.desc) {
            const codes = extractInviteCodes(group.desc);
            codes.forEach((c) => discoveredCodes.add(c));
          }
        }

        console.log(`🔍 Found ${discoveredCodes.size} link(s) in existing group descriptions.`);

        // 2. Process initial discovered batch with delays
        if (discoveredCodes.size > 0) {
          console.log('\n⚡ Joining discovered groups from descriptions...\n');
          for (const code of discoveredCodes) {
            await processInviteCode(sock, code, existingGroupJids);
            const waitTime = getRandomDelay();
            console.log(`⏳ Delaying ${(waitTime / 1000).toFixed(1)}s before next attempt...\n`);
            await delay(waitTime);
          }
        }

        console.log('📡 Listening live for new group invite links posted in any chat...\n');

      } catch (err) {
        console.error('❌ Error during group scanning:', err.message);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        startAddGroups();
      }
    }
  });

  // 3. Real-time Listener: Catches invite links posted live in any message
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const codes = extractInviteCodes(body);
      if (codes.length > 0) {
        for (const code of codes) {
          if (processedCodes.has(code)) continue;

          console.log(`\n✨ Live Invite Link Found in chat [${msg.key.remoteJid}]: ${code}`);
          await processInviteCode(sock, code);
          const waitTime = getRandomDelay();
          console.log(`⏳ Cooldown: waiting ${(waitTime / 1000).toFixed(1)}s...\n`);
          await delay(waitTime);
        }
      }
    }
  });
}

startAddGroups().catch(console.error);