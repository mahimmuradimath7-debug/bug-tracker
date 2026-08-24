require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');
const { createClient } = require('@supabase/supabase-js');

const { parseGithubUrl, collectGithubFiles } = require('./services/github');
const { collectZipFiles } = require('./services/zipService');
const { analyzeFile } = require('./services/analyze');
const storage = require('./services/storage');

const app = express();
app.use(cors());
app.use(express.json());

const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) console.warn("WARNING: SUPABASE_URL or SUPABASE_ANON_KEY is not set.");
const supabase = createClient(supabaseUrl || 'https://example.supabase.co', supabaseAnonKey || 'dummy');

app.get('/api/config', (req, res) => res.json({ supabaseUrl, supabaseAnonKey }));

const authMiddleware = async (req, res, next) => {
  const token = (req.headers.authorization && req.headers.authorization.split(' ')[1]) || req.query.token;
  if (!token) {
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      const stream = sse(res);
      stream.send('error', { message: 'Unauthorized' });
      return res.end();
    }
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      const stream = sse(res);
      stream.send('error', { message: 'Unauthorized: Invalid token' });
      return res.end();
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  
  req.user = user;
  req.token = token;
  next();
};
const upload = multer({ 
  dest: TMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are allowed'));
    }
  }
});

const uploadRaw = multer({ 
  dest: TMP_DIR,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit for raw code
});

if (!process.env.GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. Copy backend/.env.example to backend/.env and add your key for the bug tracker to work.');
}

// --- Step 1 of a zip scan: upload the file, get a tempId back ---
app.post('/api/upload/zip', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ tempId: req.file.filename, name: req.file.originalname });
});

// --- Step 1 of a raw code scan: upload the text, get a tempId back ---
app.post('/api/upload/raw', authMiddleware, uploadRaw.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No raw code provided' });
  res.json({ tempId: req.file.filename });
});

function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  };
}

async function handleScanRequest(req, res, sourceLabel, collectFilesFn) {
  const stream = sse(res);
  try {
    stream.send('log', { message: `preparing ${sourceLabel} ...` });
    const files = await collectFilesFn();
    if (files.length === 0) throw new Error('No scannable source files found');
    stream.send('log', { message: `found ${files.length} file(s) to review` });

    const bugs = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      stream.send('log', { message: `scanning ${f.path} ...` });
      try {
        const found = await analyzeFile(f.path, f.content);
        found.forEach(b => {
          bugs.push({
            id: 'b' + crypto.randomBytes(4).toString('hex'),
            file: f.path,
            line: b.line || null,
            severity: ['critical', 'high', 'medium', 'low'].includes(b.severity) ? b.severity : 'medium',
            title: b.title || 'Issue found',
            description: b.description || '',
            status: 'open'
          });
        });
        if (found.length) stream.send('log', { message: `  -> ${found.length} issue(s) found` });
      } catch (e) {
        stream.send('log', { message: `  -> couldn't analyze ${f.path}: ${e.message}`, error: true });
      }
      stream.send('progress', { pct: Math.round(((i + 1) / files.length) * 100) });
    }

    const scan = {
      id: crypto.randomBytes(6).toString('hex'),
      source: sourceLabel,
      files: files.map(f => f.path),
      bugs,
      createdAt: Date.now()
    };
    await storage.saveScan(req.token, req.user.id, scan);

    stream.send('done', { scanId: scan.id, bugs: scan.bugs });
  } catch (e) {
    console.error('Scan Error:', e.stack || e);
    stream.send('error', { message: 'An internal error occurred during the scan.' });
  } finally {
    res.end();
  }
}

// --- Scan a public GitHub repo (Server-Sent Events for live progress) ---
app.get('/api/scan/github/stream', authMiddleware, (req, res) => {
  try {
    z.string().url().parse(req.query.url);
  } catch (e) {
    const stream = sse(res);
    stream.send('error', { message: 'Invalid URL format' });
    return res.end();
  }
  const parsed = parseGithubUrl(req.query.url);
  if (!parsed) {
    const stream = sse(res);
    stream.send('error', { message: 'Enter a valid GitHub repo URL, e.g. https://github.com/owner/repo' });
    return res.end();
  }
  handleScanRequest(req, res, `github:${parsed.owner}/${parsed.repo}`, () => collectGithubFiles(parsed.owner, parsed.repo));
});

// --- Scan a previously uploaded zip (Server-Sent Events for live progress) ---
app.get('/api/scan/zip/stream', authMiddleware, (req, res) => {
  try {
    z.string().min(1).regex(/^[a-f0-9]+$/i).parse(req.query.tempId);
  } catch (e) {
    const stream = sse(res);
    stream.send('error', { message: 'Invalid tempId format' });
    return res.end();
  }
  const tempId = req.query.tempId;
  const filePath = path.join(TMP_DIR, tempId);
  if (!fs.existsSync(filePath)) {
    const stream = sse(res);
    stream.send('error', { message: 'Upload a zip file first or file expired' });
    return res.end();
  }
  handleScanRequest(req, res, `zip:${req.query.name || tempId}`, () => {
    const files = collectZipFiles(filePath);
    fs.unlink(filePath, () => {});
    return files;
  });
});

// --- Scan raw pasted code (Server-Sent Events for live progress) ---
app.get('/api/scan/raw/stream', authMiddleware, (req, res) => {
  try {
    z.string().min(1).regex(/^[a-f0-9]+$/i).parse(req.query.tempId);
  } catch (e) {
    const stream = sse(res);
    stream.send('error', { message: 'Invalid tempId format' });
    return res.end();
  }
  const tempId = req.query.tempId;
  const filePath = path.join(TMP_DIR, tempId);
  if (!fs.existsSync(filePath)) {
    const stream = sse(res);
    stream.send('error', { message: 'Raw code not found or expired' });
    return res.end();
  }
  handleScanRequest(req, res, `raw:pasted_code`, () => {
    const content = fs.readFileSync(filePath, 'utf8');
    fs.unlink(filePath, () => {});
    return [{ path: 'pasted_code.txt', content: content.slice(0, 50000) }];
  });
});

// --- Scan history ---
app.get('/api/scans', authMiddleware, async (req, res) => res.json(await storage.listScans(req.token)));

app.get('/api/scans/:id', authMiddleware, async (req, res) => {
  const scan = await storage.getScan(req.token, req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

app.patch('/api/scans/:scanId/bugs/:bugId', authMiddleware, async (req, res) => {
  try {
    const status = z.enum(['open', 'resolved']).parse(req.body.status);
    const scanId = z.string().regex(/^[a-f0-9]+$/i).parse(req.params.scanId);
    const bugId = z.string().regex(/^b[a-f0-9]+$/i).parse(req.params.bugId);
    
    const bug = await storage.updateBugStatus(req.token, scanId, bugId, status);
    res.json(bug);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }
    console.error('Patch Error:', e.stack || e);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// --- Serve the frontend ---
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Global error handler (e.g. for Multer size limits)
app.use((err, req, res, next) => {
  console.error('Express Error:', err.stack || err);
  res.status(err.status || 500).json({ error: 'An internal error occurred' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Bug tracker running at http://localhost:${PORT}`);
});
