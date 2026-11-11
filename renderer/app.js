'use strict';
const $ = (s) => document.querySelector(s);
const state = {
  game: 'ets2', profiles: [], profile: null,
  mods: new Map(),          // id -> installed mod info
  active: [],               // [{id,name}] in UI order: index 0 = TOP = highest priority
  saved: '',                // serialized active list as last loaded/saved
  selA: new Set(), selV: new Set(), lastA: null, lastV: null,
  undo: [], redo: [],
  onlyBad: false, gameVersion: null,
};
const isBad = (id) => state.mods.get(id)?.compatInfo?.status === 'bad';

const key = (a) => a.map((m) => m.id).join('\n');
const dirty = () => key(state.active) !== state.saved;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function status(msg, err) { const s = $('#status'); s.textContent = msg; s.className = 'status-text' + (err ? ' err' : ''); $('.status').classList.toggle('err', !!err); }

// ---------- data loading ----------
async function loadGame() {
  status('Scanning mods and profiles…');
  const [profiles, mods, gv] = await Promise.all([api.profiles(state.game), api.mods(state.game), api.gameVersion(state.game)]);
  state.profiles = profiles; state.gameVersion = gv;
  state.mods = new Map(mods.map((m) => [m.id, m]));
  const sel = $('#profile');
  sel.innerHTML = profiles.length
    ? profiles.map((p, i) => `<option value="${i}">${esc(p.name)} — ${esc(p.source)}</option>`).join('')
    : '<option value="">No profiles found</option>';
  if (profiles.length) await loadProfile(0);
  else { state.profile = null; state.active = []; state.saved = ''; render(); status(`No ${state.game.toUpperCase()} profiles found. ${mods.length} mods installed.`, true); }
}

async function loadProfile(i) {
  const p = state.profiles[i];
  state.profile = p;
  try {
    const r = await api.loadProfile(p.file);
    state.active = r.active.slice().reverse();   // file order is bottom-up
    state.saved = key(state.active);
    state.undo = []; state.redo = []; state.selA.clear(); state.selV.clear();
    render();
    status(`${p.name}: ${state.active.length} active, ${state.mods.size} installed.`);
  } catch (e) { state.active = []; render(); status(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
}

// ---------- editing ----------
function commit(next) {
  state.undo.push(state.active); state.redo = [];
  if (state.undo.length > 100) state.undo.shift();
  state.active = next; render();
}
function activate(ids, at) {
  const have = new Set(state.active.map((m) => m.id));
  const add = ids.filter((id) => !have.has(id)).map((id) => ({ id, name: state.mods.get(id)?.name || id }));
  if (!add.length) return;
  const next = state.active.slice();
  next.splice(at ?? 0, 0, ...add);
  commit(next);
}
function deactivate(ids) {
  const s = new Set(ids);
  commit(state.active.filter((m) => !s.has(m.id)));
  ids.forEach((id) => state.selA.delete(id));
}
function moveSelected(mode) {
  const sel = state.selA; if (!sel.size) return;
  const a = state.active.slice(), picked = a.filter((m) => sel.has(m.id)), rest = a.filter((m) => !sel.has(m.id));
  if (mode === 'top') return commit([...picked, ...rest]);
  if (mode === 'bottom') return commit([...rest, ...picked]);
  const d = mode === 'up' ? -1 : 1, idx = a.map((m, i) => (sel.has(m.id) ? i : -1)).filter((i) => i >= 0);
  if ((d < 0 && idx[0] === 0) || (d > 0 && idx[idx.length - 1] === a.length - 1)) return;
  const order = d < 0 ? idx : idx.slice().reverse();
  for (const i of order) [a[i], a[i + d]] = [a[i + d], a[i]];
  commit(a);
}
function undo() { if (state.undo.length) { state.redo.push(state.active); state.active = state.undo.pop(); render(); } }
function redo() { if (state.redo.length) { state.undo.push(state.active); state.active = state.redo.pop(); render(); } }

// ---------- rendering ----------
function modRow(m, opts) {
  const info = state.mods.get(m.id);
  const missing = opts.active && !info;
  const name = info?.name || m.name || m.id;
  const icon = info?.iconData ? `style="background-image:url('${info.iconData}')"` : '';
  const sub = [info?.version && `v${info.version}`, info?.author, info?.hashfs && 'metadata not read (HashFS)'].filter(Boolean).join('  ·  ') || m.id;
  const bad = info?.compatInfo?.status === 'bad';
  const tag = (missing ? '<span class="tag MISSING">MISSING</span>' : `${bad ? `<span class="tag BAD" title="${esc(info.compatInfo.note)}">INCOMPATIBLE</span>` : ''}<span class="tag ${info.source}" title="${esc(info.compatInfo?.note || '')}">${info.source === 'STEAM' ? 'WORKSHOP' : 'FILE'}</span>`)
    + `<button class="find ${bad || missing ? 'show' : ''}" title="Find an updated version">⟳</button>`;
  const pos = opts.active ? `<div class="pos">${opts.n}</div>` : '';
  return `<li class="mod ${missing ? 'missing' : ''} ${opts.cls || ''}" draggable="true" data-id="${esc(m.id)}" title="${esc(m.id)}">${pos}<div class="ico" ${icon}>${icon ? '' : '▣'}</div><div class="info"><div class="title">${esc(name)}</div><div class="sub">${esc(sub)}</div></div><div class="right">${tag}</div></li>`;
}

function render() {
  const aq = $('#activeSearch').value.toLowerCase(), vq = $('#availSearch').value.toLowerCase(), src = $('#srcFilter').value;
  const activeIds = new Set(state.active.map((m) => m.id));
  const nm = (m) => (state.mods.get(m.id)?.name || m.name || m.id);

  const act = state.active.map((m, i) => ({ m, n: i + 1 })).filter(({ m }) => (!aq || (nm(m) + m.id).toLowerCase().includes(aq)) && (!state.onlyBad || isBad(m.id)));
  $('#activeList').innerHTML = act.length
    ? act.map(({ m, n }) => modRow(m, { active: true, n, cls: state.selA.has(m.id) ? 'sel' : '' })).join('')
    : `<li class="empty">${state.active.length ? 'No matches' : 'No active mods'}</li>`;

  const avail = [...state.mods.values()]
    .filter((m) => (!src || m.source === src) && (!vq || (m.name + m.id).toLowerCase().includes(vq)) && (!state.onlyBad || isBad(m.id)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  $('#availList').innerHTML = avail.length
    ? avail.map((m) => modRow(m, { cls: (state.selV.has(m.id) ? 'sel ' : '') + (activeIds.has(m.id) ? 'is-active' : '') })).join('')
    : '<li class="empty">No mods found</li>';

  $('#activeCount').textContent = `(${state.active.length})`;
  $('#availCount').textContent = `(${avail.length}/${state.mods.size})`;
  const badActive = state.active.filter((m) => isBad(m.id)).length;
  const bb = $('#incompat');
  bb.textContent = `⚠ ${badActive}`; bb.classList.toggle('warn', badActive > 0); bb.classList.toggle('on', state.onlyBad);
  $('#ver').textContent = state.gameVersion ? `game ${state.gameVersion}` : '';
  const d = dirty();
  $('#dirty').hidden = !d; $('#save').disabled = !d || !state.profile;
  $('#undo').disabled = !state.undo.length; $('#redo').disabled = !state.redo.length;
  state.shownAvail = avail.map((m) => m.id);
}

// ---------- selection & events ----------
function clickSelect(e, which) {
  const li = e.target.closest('.mod'); if (!li) return;
  const id = li.dataset.id, set = which === 'A' ? state.selA : state.selV;
  const order = [...li.parentElement.querySelectorAll('.mod')].map((x) => x.dataset.id);
  if (e.shiftKey && state['last' + which]) {
    const a = order.indexOf(state['last' + which]), b = order.indexOf(id);
    if (!e.ctrlKey) set.clear();
    order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => set.add(x));
  } else if (e.ctrlKey) { set.has(id) ? set.delete(id) : set.add(id); state['last' + which] = id; }
  else { set.clear(); set.add(id); state['last' + which] = id; }
  render();
}

// "Find update" menu: Workshop mods link straight to their page; everything can be searched.
function openFindMenu(btn) {
  const li = btn.closest('.mod'), id = li.dataset.id, info = state.mods.get(id);
  const entry = state.active.find((m) => m.id === id);
  const mod = { workshopId: info?.workshopId, name: info?.name || entry?.name || id };
  const items = [];
  if (info?.workshopId) items.push(['page', 'Open Workshop page']);
  items.push(['workshop', 'Search Steam Workshop'], ['web', 'Search the web']);
  const menu = $('#findMenu');
  menu.innerHTML = items.map(([k, label]) => `<button data-kind="${k}">${label}</button>`).join('');
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 2, innerHeight - menu.offsetHeight - 4)}px`;
  menu.style.left = `${Math.max(4, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 4))}px`;
  menu.onclick = (e) => { const k = e.target.dataset.kind; if (k) { api.findUpdate(k, state.game, mod); menu.hidden = true; } };
}
document.addEventListener('click', (e) => { if (!e.target.closest('.find')) $('#findMenu').hidden = true; });

function wireList(listEl, which) {
  listEl.addEventListener('click', (e) => {
    const f = e.target.closest('.find');
    if (f) { e.stopPropagation(); return openFindMenu(f); }
    clickSelect(e, which);
  });
  listEl.addEventListener('dblclick', (e) => {
    const li = e.target.closest('.mod'); if (!li) return;
    which === 'A' ? deactivate([li.dataset.id]) : activate([li.dataset.id], 0);
  });
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.mod'); if (!li) return;
    const set = which === 'A' ? state.selA : state.selV;
    if (!set.has(li.dataset.id)) { set.clear(); set.add(li.dataset.id); render(); }
    const ids = which === 'A' ? state.active.filter((m) => set.has(m.id)).map((m) => m.id) : [...set];
    e.dataTransfer.setData('text/plain', JSON.stringify({ from: which, ids }));
    e.dataTransfer.effectAllowed = 'move';
  });
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault(); listEl.classList.add('over');
    listEl.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (which === 'A') { const t = dropTarget(e); if (t.li) t.li.classList.add(t.after ? 'drop-after' : 'drop-before'); }
  });
  listEl.addEventListener('dragleave', (e) => { if (e.target === listEl) listEl.classList.remove('over'); });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault(); listEl.classList.remove('over');
    let d; try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (which === 'A') {
      const t = dropTarget(e); let at = t.li ? state.active.findIndex((m) => m.id === t.li.dataset.id) + (t.after ? 1 : 0) : state.active.length;
      if (d.from === 'V') { activate(d.ids, at); }
      else {
        const s = new Set(d.ids), before = state.active.slice(0, at).filter((m) => s.has(m.id)).length;
        const moved = state.active.filter((m) => s.has(m.id)), rest = state.active.filter((m) => !s.has(m.id));
        rest.splice(at - before, 0, ...moved); commit(rest);
      }
    } else if (d.from === 'A') deactivate(d.ids);
  });
  listEl.addEventListener('dragend', () => { listEl.classList.remove('over'); render(); });
}
function dropTarget(e) {
  const li = e.target.closest('.mod'); if (!li) return { li: null };
  const r = li.getBoundingClientRect(); return { li, after: e.clientY > r.top + r.height / 2 };
}

wireList($('#activeList'), 'A'); wireList($('#availList'), 'V');
$('#availSearch').oninput = render; $('#activeSearch').oninput = render; $('#srcFilter').onchange = render;
$('#up').onclick = () => moveSelected('up'); $('#down').onclick = () => moveSelected('down');
$('#top').onclick = () => moveSelected('top'); $('#bottom').onclick = () => moveSelected('bottom');
$('#removeSel').onclick = () => deactivate([...state.selA]);
$('#addAll').onclick = () => activate(state.shownAvail, 0);
$('#incompat').onclick = () => { state.onlyBad = !state.onlyBad; render(); };
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#reload').onclick = () => (dirty() && !confirm('Discard unsaved changes?')) || loadGame();
$('#profile').onchange = (e) => (dirty() && !confirm('Discard unsaved changes?') ? (e.target.value = state.profiles.indexOf(state.profile)) : loadProfile(+e.target.value));
async function showFolders(list) {
  list = list || await api.folders(state.game);
  $('#foldersGame').textContent = `(${state.game.toUpperCase()})`;
  $('#foldersList').innerHTML = list.length
    ? list.map((d) => `<li><span title="${esc(d)}">${esc(d)}</span><button data-dir="${esc(d)}">Remove</button></li>`).join('')
    : '<li><span class="sub">No extra folders yet.</span></li>';
}
async function rescanMods() {
  const mods = await api.mods(state.game);
  state.mods = new Map(mods.map((m) => [m.id, m]));
  render(); status(`${state.mods.size} mods installed.`);
}
$('#folders').onclick = async () => { await showFolders(); $('#foldersDlg').showModal(); };
$('#closeFolders').onclick = () => $('#foldersDlg').close();
$('#addFolder').onclick = async () => { await showFolders(await api.addFolder(state.game)); await rescanMods(); };
$('#foldersList').onclick = async (e) => {
  const d = e.target.dataset.dir; if (!d) return;
  await showFolders(await api.removeFolder(state.game, d)); await rescanMods();
};
$('#launch').onclick = () => api.launch(state.game);
$('#backup').onclick = async () => {
  if (!state.profile) return;
  const f = await api.backup(state.profile.file, state.profile.name);
  status(f ? `Backup saved: ${f}` : 'Backup cancelled.');
};
$('#gameSeg').onclick = (e) => {
  const g = e.target.dataset.game; if (!g || g === state.game) return;
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  state.game = g; document.querySelectorAll('#gameSeg button').forEach((b) => b.classList.toggle('on', b.dataset.game === g)); loadGame();
};
$('#save').onclick = async () => {
  try {
    const r = await api.saveProfile(state.profile.file, state.active.slice().reverse());
    state.saved = key(state.active); render(); status(`Saved. Backup: ${r.backup}`);
  } catch (e) { status(`Save failed: ${e.message}`, true); }
};
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return;
  if (e.ctrlKey && e.key === 'z') undo(); else if (e.ctrlKey && e.key === 'y') redo();
  else if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (!$('#save').disabled) $('#save').click(); }
  else if (e.key === 'Delete') deactivate([...state.selA]);
});
window.addEventListener('beforeunload', (e) => { if (dirty()) e.returnValue = ''; });

loadGame();
