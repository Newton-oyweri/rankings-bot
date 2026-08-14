const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');
const cheerio = require('cheerio');

// Configuration & Safety Delays
const MIN_DELAY_MS = 25000; // 25s minimum delay between joins
const MAX_DELAY_MS = 50000; // 50s maximum delay between joins

// Search targets & keywords
const SEARCH_KEYWORDS = ['efootball', 'pes', 'efootball kenya', 'efootball tournament'];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

// Regex to extract WhatsApp group invite codes (20-25 chars)
function extractInviteCodes(text) {
  if (!text) return [];
  const regex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,25})/g;
  const matches = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.add(match[1]);
  }
  return Array.from(matches);
}

// Web Scraper Engine: Searches public directories and duckduckgo for links
async function scrapeWebForGroupLinks() {
  console.log('🌐 Starting Web Scraper for eFootball WhatsApp groups...\n');
  const discoveredCodes = new Set();

  // Source 1: Scrape DuckDuckGo HTML for indexed WhatsApp links
  for (const keyword of SEARCH_KEYWORDS) {
    try {
      const query = `site:chat.whatsapp.com "${keyword}"`;
      console.log(`🔍 Searching DuckDuckGo for: [${query}]`);

      const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        },
        timeout: 10000
      });

      const codes = extractInviteCodes(response.data);
      codes.forEach((c) => discoveredCodes.add(c));
      console.log(`   └─ Found ${codes.length} link(s) for keyword "${keyword}"`);
    } catch (err) {
      console.error(`⚠️ Search query failed for "${keyword}":`, err.message);
    }
  }

  // Source 2: Scrape public WhatsApp group listing directories
  const directoryUrls = [
    'https://whatsgrouplink.com/efootball-whatsapp-group-links/',
    'https://grouplinks.in/efootball-pes-whatsapp-group-links/'
  ];

  for (const url of directoryUrls) {
    try {
      console.log(`🔍 Scraping Group Directory: [${url}]`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const codes = extractInviteCodes(response.data);
      codes.forEach((c) => discoveredCodes.add(c));
      console.log(`   └─ Extracted ${codes.length} link(s) from directory`);
    } catch (err) {
      console.error(`⚠️ Directory scrape failed for [${url}]:`, err.message);
    }
  }

  console.log(`\n🎉 Web Scraping Complete! Total unique invite codes gathered: ${discoveredCodes.size}\n`);
  return Array.from(discoveredCodes);
}

// Auto-Join Engine
const processedCodes = new Set();

async function joinGroupFromCode(sock, code, existingGroupJids = new Set()) {
  if (processedCodes.has(code)) return;
  processedCodes.add(code);

  try {
    const info = await sock.groupGetInviteInfo(code);

    if (!info || !info.id) {
      console.log(`⚠️ Expired or invalid invite code: ${code}`);
      return;
    }

    const groupJid = `${info.id}@g.us`;

    if (existingGroupJids.has(groupJid)) {
      console.log(`ℹ️ Already a member of: "${info.subject}". Skipping.`);
      return;
    }

    console.log(`🎯 Group Discovered: "${info.subject}" (${info.size || '?'} members)`);
    console.log(`🤝 Attempting to join...`);

    const joinedJid = await sock.groupAcceptInvite(code);
    console.log(`🎉 Successfully joined "${info.subject}"!`);

    existingGroupJids.add(joinedJid || groupJid);

  } catch (err) {
    console.error(`❌ Failed to join group [${code}]:`, err.message || err);
  }
}

async function startWebGroupJoiner() {
  console.log('🚀 Launching Web Group Discovery & Auto-Joiner Engine...');

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
        // Fetch current groups to avoid duplicate attempts
        const currentGroups = await sock.groupFetchAllParticipating();
        const existingGroupJids = new Set(Object.keys(currentGroups));
        console.log(`📋 Account is currently in ${existingGroupJids.size} group(s).`);

        // 1. Run the Web Scraper
        const webScrapedCodes = await scrapeWebForGroupLinks();

        // 2. Queue and join discovered web groups with randomized delays
        if (webScrapedCodes.length > 0) {
          console.log(`⚡ Processing ${webScrapedCodes.length} scraped group links...\n`);

          for (const code of webScrapedCodes) {
            await joinGroupFromCode(sock, code, existingGroupJids);
            const waitTime = getRandomDelay();
            console.log(`⏳ Safety Cooldown: waiting ${(waitTime / 1000).toFixed(1)}s before next attempt...\n`);
            await delay(waitTime);
          }
        } else {
          console.log('ℹ️ No web links found on this run.');
        }

        console.log('✨ Finished processing web scraped groups.');

      } catch (err) {
        console.error('❌ Error during discovery/join process:', err.message);
      } finally {
        setTimeout(() => process.exit(0), 3000);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        startWebGroupJoiner();
      }
    }
  });
}

startWebGroupJoiner().catch(console.error);