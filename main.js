const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { GAMES, findProfiles, scanMods, gameVersion } = require('./lib/scan');
const { evaluate } = require('./lib/compat');
const sii = require('./lib/sii');

const docs = () => app.getPath('documents');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    icon: path.join(__dirname, 'build', 'icon.png'), backgroundColor: '#14171c', autoHideMenuBar: true, title: 'Truck Mod Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('games', () => GAMES);
ipcMain.handle('profiles', (_e, game) => findProfiles(game, docs()));
// Per-game extra mod folders, persisted in the app's user-data folder.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const getFolders = (game) => (readSettings().folders || {})[game] || [];
function setFolders(game, list) {
  const s = readSettings(); s.folders = { ...(s.folders || {}), [game]: list };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  return list;
}

// Mods whose manifest has no display_name get the name any profile saved for them.
function knownNames(game) {
  const names = new Map();
  for (const p of findProfiles(game, docs())) {
    try { for (const m of sii.parseActiveMods(sii.readSii(p.file))) if (m.name && m.name !== m.id && !names.has(m.id)) names.set(m.id, m.name); } catch { /* unreadable profile */ }
  }
  return names;
}
// Steam Workshop titles for still-unnamed items: public API, sends only item IDs, cached on disk.
const titlesFile = () => path.join(app.getPath('userData'), 'workshop-titles.json');
const readTitles = () => { try { return JSON.parse(fs.readFileSync(titlesFile(), 'utf8')); } catch { return {}; } };
async function lookupTitles(ids) {
  const cache = readTitles();
  const todo = ids.filter((id) => !(id in cache));
  if (todo.length) {
    try {
      const body = new URLSearchParams({ itemcount: String(todo.length) });
      todo.forEach((id, i) => body.append(`publishedfileids[${i}]`, id));
      const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
        method: 'POST', body, signal: AbortSignal.timeout(8000),
      });
      const j = await res.json();
      for (const d of j.response?.publishedfiledetails || []) if (d.title) cache[d.publishedfileid] = d.title;
      fs.mkdirSync(path.dirname(titlesFile()), { recursive: true });
      fs.writeFileSync(titlesFile(), JSON.stringify(cache, null, 2));
    } catch { /* offline: leave names as IDs, retry next scan */ }
  }
  return cache;
}

ipcMain.handle('mods', async (_e, game) => {
  const mods = scanMods(game, docs(), getFolders(game));
  const known = mods.some((m) => m.name === m.id) ? knownNames(game) : null;
  let out = mods.map((m) => (known && m.name === m.id && known.has(m.id) ? { ...m, name: known.get(m.id) } : m));
  const still = out.filter((m) => m.name === m.id && m.workshopId);
  if (still.length) {
    const titles = await lookupTitles(still.map((m) => m.workshopId));
    out = out.map((m) => (m.name === m.id && titles[m.workshopId] ? { ...m, name: titles[m.workshopId] } : m));
  }
  const ver = await gameVersion(game, docs());
  return out.map((m) => ({ ...m, compatInfo: evaluate(m, ver) }));
});
ipcMain.handle('game-version', (_e, game) => gameVersion(game, docs()));

// Find-update links: built here from validated pieces; only https URLs are opened.
ipcMain.handle('find-update', (_e, kind, game, mod) => {
  const appId = GAMES[game]?.appId;
  const name = String(mod?.name || '').slice(0, 120);
  let url;
  if (kind === 'page' && /^\d+$/.test(String(mod?.workshopId))) url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshopId}`;
  else if (kind === 'workshop' && appId) url = `https://steamcommunity.com/workshop/browse/?appid=${appId}&searchtext=${encodeURIComponent(name)}&browsesort=textsearch`;
  else if (kind === 'web') url = `https://www.google.com/search?q=${encodeURIComponent(`${name} ${GAMES[game]?.short || ''} mod`)}`;
  if (url) shell.openExternal(url);
  return !!url;
});
ipcMain.handle('folders', (_e, game) => getFolders(game));
ipcMain.handle('add-folder', async (e, game) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: `Add ${GAMES[game].short} mod folder (contains .scs / .zip files)`, properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return getFolders(game);
  const cur = getFolders(game);
  return cur.includes(r.filePaths[0]) ? cur : setFolders(game, [...cur, r.filePaths[0]]);
});
ipcMain.handle('remove-folder', (_e, game, dir) => setFolders(game, getFolders(game).filter((d) => d !== dir)));

ipcMain.handle('load-profile', (_e, file) => {
  const text = sii.readSii(file);
  return { name: sii.parseProfileName(text), active: sii.parseActiveMods(text) };
});

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(path.dirname(file), `profile.sii.backup-${stamp}`);
  fs.copyFileSync(file, dest);
  return dest;
}

ipcMain.handle('save-profile', (_e, file, mods) => {
  const text = sii.readSii(file);
  const bak = backup(file);
  fs.writeFileSync(file, sii.writeActiveMods(text, mods), 'utf8');
  return { backup: bak };
});

// Manual backup: user picks filename and folder (last folder is remembered).
ipcMain.handle('backup', async (e, file, profileName) => {
  const s = readSettings();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(profileName || 'profile').replace(/[<>:"/\\|?*]+/g, '_');
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Save profile backup',
    defaultPath: path.join(s.backupDir || docs(), `${safe}_${stamp}.sii`),
    filters: [{ name: 'SII profile', extensions: ['sii'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.copyFileSync(file, r.filePath);
  s.backupDir = path.dirname(r.filePath);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  return r.filePath;
});
ipcMain.handle('launch', (_e, game) => shell.openExternal(`steam://rungameid/${GAMES[game].appId}`));
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
