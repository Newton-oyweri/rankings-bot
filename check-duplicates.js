const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://bkmdutrvxugyrwthmtjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4IGJpyudIfDqJGKssifbrg_Lt4RYh1p';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkDatabaseStats() {
  console.log('📊 Fetching database statistics from Supabase...\n');

  // Total contacts
  const { count: totalContacts, error: totalErr } = await supabase
    .from('group_subscribers')
    .select('*', { count: 'exact', head: true });

  // Opted-in contacts
  const { count: optedInContacts, error: optErr } = await supabase
    .from('group_subscribers')
    .select('*', { count: 'exact', head: true })
    .eq('opted_in', true);

  // Unconfirmed / Pending contacts
  const { count: pendingContacts, error: pendErr } = await supabase
    .from('group_subscribers')
    .select('*', { count: 'exact', head: true })
    .eq('opted_in', false);

  if (totalErr || optErr || pendErr) {
    console.error('❌ Error fetching stats:', totalErr || optErr || pendErr);
    return;
  }

  console.log('====================================');
  console.log(`📱 Total Unique Contacts:    ${totalContacts}`);
  console.log(`✅ Subscribed (Opted-In):    ${optedInContacts}`);
  console.log(`⏳ Unconfirmed (Pending):   ${pendingContacts}`);
  console.log('====================================\n');
}

checkDatabaseStats();