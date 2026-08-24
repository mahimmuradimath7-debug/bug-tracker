// If you ever host the frontend separately from the backend, point this at
// the backend's origin, e.g. 'http://localhost:4000'.
// TODO for Android APK: 
// Before you build the APK, you must change API_BASE to the public URL of your hosted backend (e.g. 'https://my-bug-tracker-backend.com')
// Otherwise, the Android app will not be able to connect to the backend server.
// For local browser testing, leave this as ''
const API_BASE = '';
let supabaseClient = null;
let currentSession = null;

const $ = id => document.getElementById(id);
let state = { mode: 'github', bugs: [], currentScanId: null };

async function initSupabase() {
  const res = await fetch(`${API_BASE}/api/config`);
  const config = await res.json();
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  
  supabaseClient.auth.onAuthStateChange((event, session) => {
    currentSession = session;
    if (session) {
      $('authWrap').classList.add('hidden');
      $('mainWrap').classList.remove('hidden');
      loadPastScans();
    } else {
      $('authWrap').classList.remove('hidden');
      $('mainWrap').classList.add('hidden');
    }
  });
}
initSupabase();

function showAuthError(msg, isSuccess = false) {
  $('authError').textContent = msg;
  $('authError').className = isSuccess ? 'auth-success' : 'auth-error';
  $('authError').classList.remove('hidden');
}

$('btnSignIn').onclick = async () => {
  $('authError').classList.add('hidden');
  const { error } = await supabaseClient.auth.signInWithPassword({ email: $('authEmail').value, password: $('authPassword').value });
  if (error) showAuthError(error.message);
};

$('btnSignUp').onclick = async () => {
  $('authError').classList.add('hidden');
  const { error, data } = await supabaseClient.auth.signUp({ email: $('authEmail').value, password: $('authPassword').value });
  if (error) {
    showAuthError(error.message);
  } else {
    // If Supabase auto-logs them in, sign them out so they must manually click Sign In
    if (data.session) {
      await supabaseClient.auth.signOut();
    }
    showAuthError('Registration successful! You can now click Sign In.', true);
  }
};

$('btnSignOut').onclick = async () => {
  await supabaseClient.auth.signOut();
};

function authHeader() {
  return currentSession ? { 'Authorization': `Bearer ${currentSession.access_token}` } : {};
}
function authTokenParam() {
  return currentSession ? `&token=${currentSession.access_token}` : '';
}

// --- tabs ---
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    state.mode = t.dataset.tab;
    $('tab-github').classList.toggle('hidden', state.mode !== 'github');
    $('tab-zip').classList.toggle('hidden', state.mode !== 'zip');
    $('tab-raw').classList.toggle('hidden', state.mode !== 'raw');
  };
});

// --- zip dropzone ---
const dz = $('dropzone');
let selectedZip = null;
dz.onclick = () => $('zipInput').click();
dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
dz.ondragleave = () => dz.classList.remove('drag');
dz.ondrop = e => {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleZipFile(e.dataTransfer.files[0]);
};
$('zipInput').onchange = e => { if (e.target.files[0]) handleZipFile(e.target.files[0]); };
function handleZipFile(f) {
  selectedZip = f;
  $('zipName').textContent = f.name;
}

// --- logging ---
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  $('logBox').appendChild(line);
  $('logBox').scrollTop = $('logBox').scrollHeight;
}
function setProgress(pct) { $('progressBar').style.width = pct + '%'; }

// --- past scans ---
async function loadPastScans() {
  try {
    const res = await fetch(`${API_BASE}/api/scans`, { headers: authHeader() });
    const scans = await res.json();
    if (!scans.length) {
      $('pastScansList').innerHTML = `<div class="past-scans-empty">No scans yet — run one below.</div>`;
      return;
    }
    $('pastScansList').innerHTML = scans.map(s => `
      <div class="past-scan-item" data-id="${s.id}">
        <span>${escapeHtml(s.source)}</span>
        <span class="meta">${s.bugCount} issue(s) · ${s.fileCount} file(s) · ${new Date(s.createdAt).toLocaleString()}</span>
      </div>
    `).join('');
    document.querySelectorAll('.past-scan-item').forEach(item => {
      item.onclick = () => openScan(item.dataset.id);
    });
  } catch (e) {
    $('pastScansList').innerHTML = `<div class="past-scans-empty">Couldn't reach the backend — is it running?</div>`;
  }
}

async function openScan(id) {
  const res = await fetch(`${API_BASE}/api/scans/${id}`, { headers: authHeader() });
  if (!res.ok) return;
  const scan = await res.json();
  state.bugs = scan.bugs;
  state.currentScanId = scan.id;
  $('resultsArea').classList.remove('hidden');
  renderResults();
  window.scrollTo({ top: $('resultsArea').offsetTop - 20, behavior: 'smooth' });
}

loadPastScans();

// --- scan flow (SSE) ---
$('scanBtn').onclick = async () => {
  $('logBox').innerHTML = '';
  $('progressPanel').classList.remove('hidden');
  $('resultsArea').classList.add('hidden');
  $('scanBtn').disabled = true;
  setProgress(0);

  try {
    let es;
    if (state.mode === 'github') {
      const url = $('githubUrl').value;
      if (!url.trim()) throw new Error('Enter a GitHub repo URL first');
      es = new EventSource(`${API_BASE}/api/scan/github/stream?url=${encodeURIComponent(url)}${authTokenParam()}`);
    } else if (state.mode === 'zip') {
      if (!selectedZip) throw new Error('Choose a .zip file first');
      log('uploading zip ...');
      const form = new FormData();
      form.append('file', selectedZip);
      const uploadRes = await fetch(`${API_BASE}/api/upload/zip`, { method: 'POST', body: form, headers: authHeader() });
      if (!uploadRes.ok) throw new Error('Upload failed');
      const { tempId, name } = await uploadRes.json();
      es = new EventSource(`${API_BASE}/api/scan/zip/stream?tempId=${tempId}&name=${encodeURIComponent(name)}${authTokenParam()}`);
    } else if (state.mode === 'raw') {
      const code = $('rawCodeInput').value;
      if (!code.trim()) throw new Error('Paste some code first');
      log('uploading code ...');
      const form = new FormData();
      const blob = new Blob([code], { type: 'text/plain' });
      form.append('file', blob, 'raw_code.txt');
      const uploadRes = await fetch(`${API_BASE}/api/upload/raw`, { method: 'POST', body: form, headers: authHeader() });
      if (!uploadRes.ok) throw new Error('Upload failed');
      const { tempId } = await uploadRes.json();
      es = new EventSource(`${API_BASE}/api/scan/raw/stream?tempId=${tempId}${authTokenParam()}`);
    }

    es.addEventListener('log', e => {
      const data = JSON.parse(e.data);
      log(data.message, data.error ? 'err' : (data.message.includes('->') ? 'cur' : null));
    });
    es.addEventListener('progress', e => {
      const data = JSON.parse(e.data);
      setProgress(data.pct);
    });
    es.addEventListener('done', e => {
      const data = JSON.parse(e.data);
      state.bugs = data.bugs;
      state.currentScanId = data.scanId;
      log(`done — ${data.bugs.length} issue(s) total`, 'cur');
      $('resultsArea').classList.remove('hidden');
      renderResults();
      loadPastScans();
      es.close();
      $('scanBtn').disabled = false;
    });
    es.addEventListener('error', e => {
      let message = 'Connection lost';
      try { message = JSON.parse(e.data).message; } catch (_) {}
      log(`error: ${message}`, 'err');
      es.close();
      $('scanBtn').disabled = false;
    });
  } catch (e) {
    log(`error: ${e.message}`, 'err');
    $('scanBtn').disabled = false;
  }
};

// --- results rendering ---
const SEV_META = {
  critical: { label: 'Critical', color: 'var(--crit)', bg: 'var(--crit-bg)' },
  high: { label: 'High', color: 'var(--high)', bg: 'var(--high-bg)' },
  medium: { label: 'Medium', color: 'var(--med)', bg: 'var(--med-bg)' },
  low: { label: 'Low', color: 'var(--low)', bg: 'var(--low-bg)' },
};
let activeSeverities = new Set(Object.keys(SEV_META));

function renderResults() {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  state.bugs.forEach(b => counts[b.severity]++);

  $('summaryChips').innerHTML = Object.keys(SEV_META).map(s => {
    const on = activeSeverities.has(s);
    return `<div class="chip ${on ? 'on' : ''}" data-sev="${s}">
      <span class="dot" style="background:${SEV_META[s].color}"></span>
      ${SEV_META[s].label} · ${counts[s]}
    </div>`;
  }).join('');

  document.querySelectorAll('.chip').forEach(c => {
    c.onclick = () => {
      const s = c.dataset.sev;
      if (activeSeverities.has(s)) activeSeverities.delete(s); else activeSeverities.add(s);
      renderResults();
    };
  });

  const query = $('searchBox').value.toLowerCase();
  const statusFilter = $('statusFilter').value;

  const visible = state.bugs.filter(b => {
    if (!activeSeverities.has(b.severity)) return false;
    if (statusFilter === 'open' && b.status !== 'open') return false;
    if (statusFilter === 'resolved' && b.status !== 'resolved') return false;
    if (query && !(b.title.toLowerCase().includes(query) || b.file.toLowerCase().includes(query) || b.description.toLowerCase().includes(query))) return false;
    return true;
  });

  if (visible.length === 0) {
    $('bugList').innerHTML = `<div class="empty">No bugs match these filters.</div>`;
    return;
  }

  $('bugList').innerHTML = visible.map(b => {
    const meta = SEV_META[b.severity];
    return `<div class="bug ${b.status === 'resolved' ? 'resolved-row' : ''}" data-id="${b.id}">
      <div class="bug-head" data-toggle="${b.id}">
        <span class="sev-tag" style="background:${meta.bg};color:${meta.color}">${meta.label}</span>
        <span class="bug-title">${escapeHtml(b.title)}</span>
        <span class="bug-file">${escapeHtml(b.file)}${b.line ? ':' + b.line : ''}</span>
      </div>
      <div class="bug-body hidden" id="body-${b.id}">
        <p>${escapeHtml(b.description)}</p>
        <div class="bug-actions">
          <span class="status-pill ${b.status === 'resolved' ? 'resolved' : ''}">${b.status}</span>
          <button class="ghost" data-toggle-status="${b.id}">${b.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-toggle]').forEach(h => {
    h.onclick = () => $('body-' + h.dataset.toggle).classList.toggle('hidden');
  });
  document.querySelectorAll('[data-toggle-status]').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.toggleStatus;
      const bug = state.bugs.find(b => b.id === id);
      const newStatus = bug.status === 'resolved' ? 'open' : 'resolved';
      try {
        await fetch(`${API_BASE}/api/scans/${state.currentScanId}/bugs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ status: newStatus })
        });
        bug.status = newStatus;
        renderResults();
        loadPastScans();
      } catch (e) {
        log(`couldn't save status change: ${e.message}`, 'err');
      }
    };
  });
}

$('searchBox').oninput = renderResults;
$('statusFilter').onchange = renderResults;

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
