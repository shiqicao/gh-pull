export const labels = {
  OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed',
  SUCCESS: 'Checks passed', FAILURE: 'Checks failed', ERROR: 'Checks error',
  PENDING: 'Checks pending', EXPECTED: 'Checks expected', NONE: 'No checks',
};

export const NAME_COLOR_COUNT = 12;

export function normalizeViewedUpdates(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= 0));
}

export function hasUnviewedUpdate(pr, viewed) {
  return !Object.hasOwn(viewed, pr.id) || Date.parse(pr.updatedAt) > viewed[pr.id];
}

function nameHash(username) {
  let hash = 2166136261;
  for (const char of username.toLowerCase()) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

// Allocate colors across the known people, rather than hashing each independently:
// hashes alone can put several colleagues on nearly identical colors.
export function assignNameColors(usernames, previous = {}) {
  const colors = Object.create(null);
  for (const [name, slot] of Object.entries(previous && typeof previous === 'object' ? previous : {})) {
    if (Number.isInteger(slot) && slot >= 0 && slot < NAME_COLOR_COUNT) colors[name.toLowerCase()] = slot;
  }
  const names = [...new Set(usernames.map(name => name.toLowerCase()))]
    .filter(name => !Object.hasOwn(colors, name))
    .sort();
  const used = Object.values(colors);
  const counts = Array(NAME_COLOR_COUNT).fill(0);
  for (const slot of used) counts[slot]++;
  const distance = (a, b) => Math.min(Math.abs(a - b), NAME_COLOR_COUNT - Math.abs(a - b));

  // On first load, spread everyone evenly around the palette.
  if (!used.length && names.length) {
    const offset = nameHash(names[0]) % NAME_COLOR_COUNT;
    const size = Math.min(names.length, NAME_COLOR_COUNT);
    names.forEach((name, i) => {
      colors[name] = (offset + Math.floor((i % size) * NAME_COLOR_COUNT / size)) % NAME_COLOR_COUNT;
    });
    return colors;
  }

  for (const name of names) {
    const preferred = nameHash(name) % NAME_COLOR_COUNT;
    let best = preferred, bestDistance = -1, bestCount = Infinity;
    for (let i = 0; i < NAME_COLOR_COUNT; i++) {
      const slot = (preferred + i) % NAME_COLOR_COUNT;
      const separation = Math.min(...Object.values(colors).map(other => distance(slot, other)));
      if (counts[slot] < bestCount || (counts[slot] === bestCount && separation > bestDistance)) {
        best = slot; bestCount = counts[slot]; bestDistance = separation;
      }
    }
    colors[name] = best;
    counts[best]++;
  }
  return colors;
}

export function groupPulls(items, { search = '', group = 'repo', sort = 'updated' } = {}) {
  const query = search.trim().toLowerCase();
  const selected = items.filter(pr => [pr.title, pr.repo, pr.author, `#${pr.number}`, ...pr.labels].join(' ').toLowerCase().includes(query));
  selected.sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) :
    sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
  const groups = new Map();
  for (const pr of selected) {
    const key = group === 'none' ? 'All pull requests' : pr[group];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pr);
  }
  return { count: selected.length, groups: [...groups].sort(([a], [b]) => a.localeCompare(b)) };
}

export function relativeTime(value, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
