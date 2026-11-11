// Decides whether a mod is compatible with the installed game version.
// status: 'ok' (declared and matches) | 'none' (no restriction declared) | 'bad' (declared, no match) | 'unknown'
const matches = (pattern, ver) => {
  const p = pattern.split('.'), v = ver.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') return true;
    if (p[i] !== v[i]) return false;
  }
  return true;
};
const cmp = (a, b) => {
  const x = a.replace(/\.\*$/, '').split('.').map(Number), y = b.replace(/\.\*$/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const newest = (list) => list.slice().sort(cmp).pop();

function evaluate(mod, ver) {
  if (!ver) return { status: 'unknown', note: 'Game version not known (run the game once)' };
  let versionedNote = '';
  if (mod.versions?.length) {
    const hit = mod.versions.find((v) => v.compat.some((c) => matches(c, ver)));
    if (hit) return { status: 'ok', note: `Package ${hit.package} matches game ${ver}` };
    const top = newest(mod.versions.flatMap((v) => v.compat));
    if (!mod.hasUniversal) return { status: 'bad', note: `No package for game ${ver}. Newest supports ${top}` };
    versionedNote = ` (newest version-specific package: ${top})`;
  }
  if (mod.compat?.length) {
    return mod.compat.some((c) => matches(c, ver))
      ? { status: 'ok', note: `Declares ${mod.compat.join(', ')}` }
      : { status: 'bad', note: `Declares ${mod.compat.join(', ')}; game is ${ver}` };
  }
  if (mod.metaRead) return { status: 'none', note: `No version restriction declared${versionedNote}` };
  return { status: 'unknown', note: 'Mod metadata could not be read' };
}

module.exports = { evaluate, matches };
