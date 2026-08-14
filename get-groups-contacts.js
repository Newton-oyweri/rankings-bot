import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const TARGET_GROUP_JID = '120363406102517771@g.us';
const GROUP_LABEL = 'rankings corner';

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
        // No local mapping available in session store
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

async function fetchAndGenerateSQL() {
    const { state, saveCreds } = await useMultiFileAuthState('./session_auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\nScan this QR code:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected!\n');

            try {
                console.log(`Fetching metadata for group JID: ${TARGET_GROUP_JID}...`);
                const groupMeta = await sock.groupMetadata(TARGET_GROUP_JID);

                console.log(`\n📌 Group Subject: "${groupMeta.subject}"`);
                console.log(`Total Members: ${groupMeta.participants.length}\n`);

                const resolvedJids = new Set();
                let unresolvedLidCount = 0;

                for (const p of groupMeta.participants) {
                    let phoneJid = extractDirectPhoneJid(p);

                    // Check session signal repository if LID-only
                    if (!phoneJid && p.id?.endsWith('@lid')) {
                        phoneJid = await resolveLidToPhoneJid(sock, p.id);
                    }

                    if (phoneJid) {
                        resolvedJids.add(phoneJid);
                    } else {
                        unresolvedLidCount++;
                    }
                }

                const jidList = Array.from(resolvedJids);

                console.log('====================================');
                console.log(`📊 Participant Summary`);
                console.log(`   Total Scanned:     ${groupMeta.participants.length}`);
                console.log(`   Resolved Phone JIDs: ${jidList.length}`);
                console.log(`   Unresolved LIDs:    ${unresolvedLidCount}`);
                console.log('====================================\n');

                if (jidList.length === 0) {
                    console.log('⚠️ No phone JIDs could be resolved. Ensure your session file (`./session_auth`) has interacted with these group members previously so Baileys has cached their mappings.');
                } else {
                    const sqlJids = jidList.map(j => `'${j}'`).join(',\n  ');

                    const sqlQuery = `-- UPDATE STATEMENT FOR: ${groupMeta.subject}\nUPDATE public.group_subscribers\nSET \n  label = '${GROUP_LABEL}',\n  updated_at = NOW()\nWHERE jid IN (\n  ${sqlJids}\n);`;

                    console.log('================ COPY & RUN THIS IN SUPABASE ================');
                    console.log(sqlQuery);
                    console.log('===========================================================');
                }

            } catch (error) {
                console.error('❌ Error reading group metadata:', error);
            } finally {
                setTimeout(() => process.exit(0), 1000);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) fetchAndGenerateSQL();
        }
    });
}

fetchAndGenerateSQL();