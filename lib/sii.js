// Reading / writing SCS profile.sii files (plain text or "ScsC" encrypted).
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const KEY = Buffer.from([
  0x2a, 0x5f, 0xcb, 0x17, 0x91, 0xd2, 0x2f, 0xb6, 0x02, 0x45, 0xb3, 0xd8, 0x36, 0x9e, 0xd0, 0xb2,
  0xc2, 0x73, 0x71, 0x56, 0x3f, 0xbf, 0x1f, 0x3c, 0x9e, 0xdf, 0x6b, 0x11, 0x82, 0x5a, 0x5d, 0x0a,
]);

function readSii(file) {
  const b = fs.readFileSync(file);
  const sig = b.slice(0, 4).toString('latin1');
  if (sig === 'ScsC') {
    const iv = b.slice(36, 52);
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    d.setAutoPadding(false);
    const enc = b.slice(56);
    const dec = Buffer.concat([d.update(enc.slice(0, enc.length - (enc.length % 16))), d.final()]);
    return zlib.inflateSync(dec).toString('utf8');
  }
  if (sig.startsWith('3nK')) {
    throw new Error('This profile uses the binary "3nK" format. Set g_save_format "2" in config.cfg and re-save in game.');
  }
  return b.toString('utf8').replace(/^\uFEFF/, '');
}

const unescapeSii = (s) => s.replace(/\\(["\\])/g, '$1');
const escapeSii = (s) => s.replace(/(["\\])/g, '\\$1');

// Returns [{ id, name }] in FILE order (index 0 first).
function parseActiveMods(text) {
  const out = [];
  const re = /^\s*active_mods\[(\d+)\]:\s*"((?:[^"\\]|\\.)*)"/gm;
  let m;
  while ((m = re.exec(text))) {
    const raw = unescapeSii(m[2]);
    const bar = raw.indexOf('|');
    out[Number(m[1])] = bar < 0 ? { id: raw, name: raw } : { id: raw.slice(0, bar), name: raw.slice(bar + 1) };
  }
  return out.filter(Boolean);
}

function parseProfileName(text) {
  const m = /^\s*profile_name:\s*"((?:[^"\\]|\\.)*)"/m.exec(text);
  return m ? unescapeSii(m[1]) : null;
}

// Replaces the active_mods block; always writes plain-text SII (the game reads it fine).
function writeActiveMods(text, mods) {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*active_mods(\[\d+\])?:/.test(l));
  const block = [` active_mods: ${mods.length}`, ...mods.map((m, i) => ` active_mods[${i}]: "${escapeSii(m.id + '|' + m.name)}"`)];
  let at = lines.findIndex((l) => /^\s*profile_name:/.test(l));
  if (at < 0) at = lines.findIndex((l) => /^\s*\w+\s*:\s*\w+\s*\{/.test(l));
  lines.splice(at + 1, 0, ...block);
  return lines.join('\r\n');
}

module.exports = { readSii, parseActiveMods, parseProfileName, writeActiveMods };
