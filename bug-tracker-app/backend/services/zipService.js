const AdmZip = require('adm-zip');
const { CODE_EXT, SKIP_DIRS, MAX_FILES, MAX_FILE_CHARS } = require('./github');

function collectZipFiles(filePath) {
  const zip = new AdmZip(filePath);
  let entries = zip.getEntries().filter(e => {
    if (e.isDirectory) return false;
    if (SKIP_DIRS.some(d => e.entryName.split('/').includes(d))) return false;
    const ext = e.entryName.split('.').pop().toLowerCase();
    return CODE_EXT.includes(ext);
  });
  entries = entries.slice(0, MAX_FILES);
  return entries.map(e => ({
    path: e.entryName,
    content: e.getData().toString('utf8').slice(0, MAX_FILE_CHARS)
  }));
}

module.exports = { collectZipFiles };
