/* The standard CLAUDE.md — one template file, named once in Options, copied
 * into every workspace folder as it is added.
 *
 * Only the *path* is stored, not the text: the template is a file the user
 * edits in their own editor, and a copy in config.json would go stale the
 * moment they did. The copy is made at add-time rather than watched, so a
 * workspace's CLAUDE.md is the repo's from then on — SwarmEye never touches
 * it again.
 *
 * Plain fs, no shell: a workspace path is a host path on both platforms (it
 * is what node-pty chdirs into), like the notebook in main.js and unlike the
 * transcripts. */
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const config = require('./config');

const TARGET = 'CLAUDE.md';

function get() {
  return config.load().claudeTemplate || '';
}

/* Absent is not an error to report — the setting can outlive the file it
 * names, and the readout says so rather than the add flow failing. */
function status() {
  const file = get();
  return { path: file, missing: !!file && !fs.existsSync(file) };
}

async function pick(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose the standard CLAUDE.md',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true, ...status() };
  config.patch({ claudeTemplate: res.filePaths[0] });
  return status();
}

function clear() {
  config.patch({ claudeTemplate: '' });
  return status();
}

/* Copy the template into `dir`. Never overwrites: a folder that already has a
 * CLAUDE.md has one for a reason, and that file is the repo's, not ours. Every
 * other failure — no template set, template deleted, unwritable folder — is a
 * quiet skip, since this runs as a side effect of adding a workspace and must
 * not be able to fail the add. */
function apply(dir) {
  const src = get();
  if (!src) return { copied: false, reason: 'no-template' };
  const dest = path.join(dir, TARGET);
  if (fs.existsSync(dest)) return { copied: false, reason: 'exists' };
  try {
    fs.copyFileSync(src, dest);
    return { copied: true };
  } catch (err) {
    return { copied: false, reason: err.code === 'ENOENT' ? 'template-missing' : err.message };
  }
}

module.exports = { get, status, pick, clear, apply };
