const CODE_EXT = ['js','jsx','ts','tsx','py','java','go','rb','php','c','cpp','h','hpp','cs','rs','swift','kt','scala','vue','svelte'];
const SKIP_DIRS = ['node_modules','dist','build','.git','vendor','venv','__pycache__','.next','coverage','target','.venv'];
const MAX_FILES = 20;
const MAX_FILE_CHARS = 6000;

function parseGithubUrl(url) {
  const m = (url || '').trim().match(/github\.com\/([^/]+)\/([^/\s#]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

async function collectGithubFiles(owner, repo) {
  const headers = { 'User-Agent': 'bug-tracker-app' };

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`Repo not found or private (${repoRes.status})`);
  const repoInfo = await repoRes.json();
  const branch = repoInfo.default_branch || 'main';

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`Could not read repo tree (${treeRes.status})`);
  const tree = await treeRes.json();
  if (!tree.tree) throw new Error('Empty or inaccessible repo tree');

  let candidates = tree.tree.filter(item => {
    if (item.type !== 'blob') return false;
    if (SKIP_DIRS.some(d => item.path.split('/').includes(d))) return false;
    const ext = item.path.split('.').pop().toLowerCase();
    if (!CODE_EXT.includes(ext)) return false;
    if (item.size && item.size > 60000) return false;
    return true;
  });
  candidates.sort((a, b) => (a.size || 0) - (b.size || 0));
  candidates = candidates.slice(0, MAX_FILES);

  const files = [];
  for (const c of candidates) {
    try {
      const raw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${c.path}`);
      if (!raw.ok) continue;
      const text = await raw.text();
      files.push({ path: c.path, content: text.slice(0, MAX_FILE_CHARS) });
    } catch (e) {
      // skip unreadable file
    }
  }
  return files;
}

module.exports = { parseGithubUrl, collectGithubFiles, CODE_EXT, SKIP_DIRS, MAX_FILES, MAX_FILE_CHARS };
