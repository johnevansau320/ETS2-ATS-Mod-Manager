// Finds game folders, profiles and installed mods (local + Steam Workshop).
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');
const { readFileFromHashFs } = require('./hashfs');

const GAMES = {
  ets2: { label: 'Euro Truck Simulator 2', short: 'ETS2', docs: 'Euro Truck Simulator 2', appId: '227300' },
  ats: { label: 'American Truck Simulator', short: 'ATS', docs: 'American Truck Simulator', appId: '270880' },
};

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

function steamRoots() {
  const roots = new Set();
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\', 'D:\\']) {
    if (!base) continue;
    for (const sub of ['Steam', 'SteamLibrary']) if (exists(path.join(base, sub))) roots.add(path.join(base, sub));
  }
  for (const r of [...roots]) {
    try {
      const vdf = fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'));
    } catch { /* no vdf */ }
  }
  return [...roots];
}

function decodeFolderName(hex) {
  if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length % 2 === 0) {
    try { return Buffer.from(hex, 'hex').toString('utf8'); } catch { /* fall through */ }
  }
  return hex;
}

// The game uses the Windows Documents folder only. The other places are fallbacks for when that
// has no game folder yet; they are never mixed in, because an old copy left behind after moving
// Documents (e.g. OneDrive\Documents) would add mods and profiles the game no longer loads.
function documentsDirs(game, documentsPath) {
  const cands = [documentsPath, path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Documents')];
  const first = [...new Set(cands)].map((d) => path.join(d, GAMES[game].docs)).find(exists);
  return first ? [first] : [];
}

function findProfiles(game, documentsPath) {
  const profiles = [];
  const add = (dir, source) => {
    for (const name of dirs(dir)) {
      const file = path.join(dir, name, 'profile.sii');
      if (exists(file)) profiles.push({ dir: path.join(dir, name), file, name: decodeFolderName(name), source });
    }
  };
  for (const d of documentsDirs(game, documentsPath)) {
    add(path.join(d, 'profiles'), 'Local');
    add(path.join(d, 'steam_profiles'), 'Steam');
  }
  for (const root of steamRoots()) {
    const ud = path.join(root, 'userdata');
    for (const acct of dirs(ud)) add(path.join(ud, acct, GAMES[game].appId, 'remote', 'profiles'), `Steam Cloud ${acct}`);
  }
  return profiles;
}

// Drops "#" and "//" comments so commented-out settings (e.g. "# compatible_versions[]") are ignored.
const stripComments = (t) => t.replace(/(^|[ \t])(#|\/\/).*$/gm, '$1');

function manifestInfo(buf) {
  const text = stripComments(buf.toString('utf8'));
  const get = (k) => { const m = new RegExp(`${k}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text); return m ? m[1] : null; };
  const cats = []; for (const m of text.matchAll(/category\[\]:\s*"([^"]+)"/g)) cats.push(m[1]);
  const compat = []; for (const m of text.matchAll(/compatible_versions\[\]:\s*"([^"]+)"/g)) compat.push(m[1]);
  return { name: get('display_name'), version: get('package_version'), author: get('author'), categories: cats, icon: get('icon'), compat };
}

// Reads manifest.sii from a ZIP-style mod. HashFS ("SCS#") archives are not parsed yet.
function readMeta(file) {
  const r = { metaRead: false };
  try {
    if (fs.statSync(file).isDirectory()) {
      Object.assign(r, manifestInfo(fs.readFileSync(path.join(file, 'manifest.sii'))), { metaRead: true });
      for (const n of ['mod_icon.jpg', 'mod_icon.png']) {
        const ip = path.join(file, n);
        if (exists(ip) && fs.statSync(ip).size < 400000) { r.iconData = `data:image/${n.endsWith('png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(ip).toString('base64')}`; break; }
      }
      return r;
    }
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.toString('latin1') === 'SCS#') {
      const man = readFileFromHashFs(file, 'manifest.sii');
      if (!man) { r.hashfs = true; return r; }
      Object.assign(r, manifestInfo(man), { metaRead: true });
      const names = [...new Set([r.icon, 'mod_icon.jpg', 'mod_icon.png'].filter((n) => n && /\.(jpe?g|png)$/i.test(n)))];
      for (const n of names) {
        const img = readFileFromHashFs(file, n, 400000);   // only 8-16 char names can be looked up
        if (img) { r.iconData = `data:image/${/png$/i.test(n) ? 'png' : 'jpeg'};base64,${img.toString('base64')}`; break; }
      }
      return r;
    }
    const zip = new AdmZip(file);
    const e = zip.getEntry('manifest.sii');
    if (e) {
      Object.assign(r, manifestInfo(e.getData()), { metaRead: true });
      const icon = zip.getEntry('mod_icon.jpg') || zip.getEntry('mod_icon.png');
      if (icon && icon.header.size < 400000) r.iconData = `data:image/${icon.entryName.endsWith('png') ? 'png' : 'jpeg'};base64,${icon.getData().toString('base64')}`;
    }
  } catch { /* unreadable */ }
  return r;
}

// Workshop items list version-specific packages (e.g. 161_content with compatible_versions) in versions.sii.
function workshopVersions(itemDir, mainFile) {
  const out = { versions: [], hasUniversal: /^universal(\.|$)/i.test(path.basename(mainFile)) };
  try {
    const text = stripComments(fs.readFileSync(path.join(itemDir, 'versions.sii'), 'utf8'));
    for (const block of text.split(/package_version_info\s*:/).slice(1)) {
      const pkg = /package_name:\s*"([^"]+)"/.exec(block)?.[1];
      const compat = [...block.matchAll(/compatible_versions\[\]:\s*"([^"]+)"/g)].map((m) => m[1]);
      if (pkg && pkg !== 'universal' && compat.length) out.versions.push({ package: pkg, compat });
    }
  } catch { /* no versions.sii */ }
  return out;
}

// Version recorded by the last game run (can be stale after a game update).
function logVersion(game, documentsPath) {
  for (const d of documentsDirs(game, documentsPath)) {
    try {
      const m = /g_game_version\s+"([\d.]+)"/.exec(fs.readFileSync(path.join(d, 'game.log.txt'), 'utf8'));
      if (m) return m[1];
    } catch { /* no log yet */ }
  }
  return null;
}

const GAME_EXE = { ets2: ['Euro Truck Simulator 2', 'eurotrucks2.exe'], ats: ['American Truck Simulator', 'amtrucks.exe'] };
function installedVersion(game) {
  const exe = steamRoots().map((r) => path.join(r, 'steamapps', 'common', GAME_EXE[game][0], 'bin', 'win_x64', GAME_EXE[game][1])).find(exists);
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:MM_EXE).VersionInfo.ProductVersion'],
      { env: { ...process.env, MM_EXE: exe }, timeout: 10000, windowsHide: true },
      (err, out) => { const v = String(out || '').trim(); resolve(/^\d+(\.\d+)+/.test(v) ? v.match(/^\d+(\.\d+)+/)[0] : null); });
  });
}
async function gameVersion(game, documentsPath) {
  return (await installedVersion(game)) || logVersion(game, documentsPath);
}

function scanMods(game, documentsPath, extraDirs = []) {
  const mods = [];
  const seen = new Set();
  const push = (m) => { if (!seen.has(m.id)) { seen.add(m.id); mods.push(m); } };

  const modDirs = [...documentsDirs(game, documentsPath).map((d) => path.join(d, 'mod')), ...extraDirs];
  for (const modDir of modDirs) {
    let files = [];
    try { files = fs.readdirSync(modDir); } catch { /* none */ }
    for (const f of files) {
      if (!/\.(scs|zip)$/i.test(f)) continue;
      const full = path.join(modDir, f);
      const id = f.replace(/\.(scs|zip)$/i, '');
      push({ id, file: full, source: 'FILE', ...readMeta(full) });
    }
  }
  for (const root of steamRoots()) {
    const wdir = path.join(root, 'steamapps', 'workshop', 'content', GAMES[game].appId);
    for (const item of dirs(wdir)) {
      const idir = path.join(wdir, item);
      // Workshop items are an unpacked "universal" folder, a universal.zip/.scs, or versioned archives.
      const find = (dir) => {
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        const isArc = (e) => e.isFile() && /\.(scs|zip)$/i.test(e.name);
        const uni = ents.find((e) => e.isDirectory() && e.name === 'universal' && exists(path.join(dir, e.name, 'manifest.sii')));
        if (uni) return path.join(dir, uni.name);
        const f = ents.find((e) => isArc(e) && /^universal\./i.test(e.name)) || ents.find(isArc);
        if (f) return path.join(dir, f.name);
        if (exists(path.join(dir, 'manifest.sii'))) return dir;
        for (const e of ents) if (e.isDirectory()) { const r = find(path.join(dir, e.name)); if (r) return r; }
        return null;
      };
      const file = find(idir);
      if (!file) continue;
      const hex = BigInt(item).toString(16).toUpperCase().padStart(16, '0');
      push({ id: `mod_workshop_package.${hex}`, file, source: 'STEAM', workshopId: item, ...readMeta(file),
        ...workshopVersions(idir, file) });
    }
  }
  return mods.map((m) => ({ ...m, name: m.name || m.id }));
}

module.exports = { GAMES, findProfiles, scanMods, gameVersion };
