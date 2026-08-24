const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

function getClient(token) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

async function saveScan(token, userId, scan) {
  const supabase = getClient(token);
  
  // Insert scan
  await supabase.from('scans').insert({
    id: scan.id,
    source: scan.source,
    files: scan.files,
    created_at: scan.createdAt,
    user_id: userId
  });
  
  // Insert bugs
  if (scan.bugs && scan.bugs.length > 0) {
    const bugsPayload = scan.bugs.map(b => ({
      id: b.id,
      scan_id: scan.id,
      file: b.file,
      line: b.line,
      severity: b.severity,
      title: b.title,
      description: b.description,
      status: b.status,
      user_id: userId
    }));
    await supabase.from('bugs').insert(bugsPayload);
  }
}

async function getScan(token, id) {
  const supabase = getClient(token);
  const { data: scan } = await supabase.from('scans').select('*').eq('id', id).single();
  if (!scan) return null;
  const { data: bugs } = await supabase.from('bugs').select('*').eq('scan_id', id);
  return {
    id: scan.id,
    source: scan.source,
    files: scan.files,
    createdAt: scan.created_at,
    bugs: bugs || []
  };
}

async function listScans(token) {
  const supabase = getClient(token);
  const { data: scans } = await supabase.from('scans').select('id, source, files, created_at').order('created_at', { ascending: false });
  if (!scans) return [];
  
  const result = [];
  for (const s of scans) {
    const { count: bugCount } = await supabase.from('bugs').select('*', { count: 'exact', head: true }).eq('scan_id', s.id);
    result.push({
      id: s.id,
      source: s.source,
      fileCount: s.files ? s.files.length : 0,
      bugCount: bugCount || 0,
      createdAt: s.created_at
    });
  }
  return result;
}

async function updateBugStatus(token, scanId, bugId, status) {
  const supabase = getClient(token);
  const { data: bug, error } = await supabase.from('bugs').update({ status }).eq('id', bugId).eq('scan_id', scanId).select().single();
  if (error || !bug) throw new Error('Bug not found or update failed');
  return bug;
}

module.exports = { saveScan, getScan, listScans, updateBugStatus };
