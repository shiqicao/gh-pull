export const labels = {
  OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed',
  SUCCESS: 'Checks passed', FAILURE: 'Checks failed', ERROR: 'Checks error',
  PENDING: 'Checks pending', EXPECTED: 'Checks expected', NONE: 'No checks',
};

export const reviewLabels = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required', REVIEW_BYPASS_AVAILABLE: 'Review bypass available' };
export const reviewStates = {
  REQUESTED: ['Awaiting review', 'review_required', '◷'], APPROVED: ['Approved', 'approved', '✓'],
  CHANGES_REQUESTED: ['Changes requested', 'changes_requested', '!'], COMMENTED: ['Commented', 'commented', '⋯'], DISMISSED: ['Review dismissed', 'dismissed', '−'],
};
export const mergeLabels = { MERGE: 'Merge', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' };
export const mergeMethodLabels = { MERGE: 'Merge commit', SQUASH: 'Squash', REBASE: 'Rebase' };

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

const reviewOrder = { CHANGES_REQUESTED: 0, REVIEW_REQUIRED: 1, APPROVED: 2, NONE: 3 };
function compareReviewStatus(a, b) {
  return (reviewOrder[a.review] ?? 3) - (reviewOrder[b.review] ?? 3)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

export function groupPulls(items, { search = '', group = 'repo', sort = 'updated' } = {}) {
  const query = search.trim().toLowerCase();
  const selected = items.filter(pr => [pr.title, pr.repo, pr.author, `#${pr.number}`, ...pr.labels].join(' ').toLowerCase().includes(query));
  if (sort !== 'query') selected.sort((a, b) => sort === 'review' ? compareReviewStatus(a, b) : sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) :
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

// Only join branches with unambiguous repository identity; fork names can collide.
export function dependencyForest(items, { allItems = items, sort = 'query' } = {}) {
  const active = pr => ['OPEN', 'DRAFT'].includes(pr.status);
  const matches = (parent, child) => parent.id !== child.id && parent.branch &&
    parent.branch === child.baseBranch && parent.repo.toLowerCase() === child.repo.toLowerCase() &&
    parent.branchRepository?.toLowerCase() === child.repo.toLowerCase();
  const nodes = new Map(items.map(pr => [pr.id, { pr, parent: null, children: [], externalParent: null, mergedParent: null, unloadedBase: false }]));
  for (const node of nodes.values()) {
    const pr = node.pr;
    if (!active(pr) || !pr.baseBranch || pr.baseBranch === pr.defaultBranch) continue;
    const candidates = allItems.filter(other => active(other) && matches(other, pr));
    if (candidates.length === 1) {
      node.parent = nodes.get(candidates[0].id) ?? null;
      if (!node.parent) node.externalParent = candidates[0];
    } else if (!candidates.length) {
      const inactive = allItems.filter(other => ['CLOSED', 'MERGED'].includes(other.status) && matches(other, pr));
      const known = inactive.length === 1 ? inactive[0] : pr.dependencyParent;
      if (known && known.id !== pr.id) {
        if (known.status === 'MERGED') node.mergedParent = known;
        else if (['OPEN', 'DRAFT', 'CLOSED'].includes(known.status)) node.externalParent = known;
      }
    }
    node.unloadedBase = Boolean(pr.defaultBranch && !node.parent && !node.externalParent && !node.mergedParent);
  }
  for (const node of nodes.values()) {
    const seen = new Set([node]);
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (seen.has(parent)) { node.parent = null; break; }
      seen.add(parent);
    }
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parent) node.parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.pr.number - b.pr.number);
  const index = new Map(items.map((pr, i) => [pr.id, i]));
  const newest = node => [node.pr, ...node.children.map(newest)].reduce((a, b) =>
    (Date.parse(b.updatedAt) || 0) > (Date.parse(a.updatedAt) || 0) ? b : a);
  const representatives = new Map(roots.map(node => [node, newest(node)]));
  roots.sort((a, b) => {
    if (sort === 'review') return compareReviewStatus(a.pr, b.pr);
    const x = representatives.get(a), y = representatives.get(b);
    if (sort === 'updated') return (Date.parse(y.updatedAt) || 0) - (Date.parse(x.updatedAt) || 0);
    if (sort === 'created' || sort === 'oldest') return ((Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0)) * (sort === 'oldest' ? -1 : 1);
    return index.get(x.id) - index.get(y.id);
  });
  return roots;
}

export function dependencyStatus(pr) {
  if (['FAILURE', 'ERROR'].includes(pr.checks)) return 'failed';
  if (['PENDING', 'EXPECTED'].includes(pr.checks)) return 'running';
  if (pr.status !== 'DRAFT' && (pr.canMerge || pr.review === 'APPROVED')) return 'ready';
  return 'review';
}

export function dependencyLanes(items, options) {
  const rows = [];
  const visit = (node, parentIndex = -1) => {
    const index = rows.length;
    rows.push({ ...node, parentIndex, lane: null, nodeStatus: dependencyStatus(node.pr) });
    for (const child of node.children) visit(child, index);
  };
  dependencyForest(items, options).forEach(node => visit(node));
  const busy = [], hasFirstChild = new Set();
  rows.forEach((node, i) => {
    if (node.parentIndex < 0) {
      if (node.children.length || node.externalParent || node.unloadedBase) node.lane = 0;
      return;
    }
    const parent = rows[node.parentIndex];
    if (!hasFirstChild.has(node.parentIndex)) {
      hasFirstChild.add(node.parentIndex); node.lane = parent.lane;
    } else {
      let lane = parent.lane + 1;
      while (busy.some(b => b.lane === lane && b.s <= i && node.parentIndex <= b.e)) lane++;
      node.lane = lane;
    }
    busy.push({ lane: node.lane, s: node.parentIndex, e: i });
  });
  const visible = rows.filter(n => n.lane !== null && n.lane <= 3);
  return { rows, gutter: visible.length ? 32 + 20 * Math.max(...visible.map(n => n.lane)) : 0 };
}

export const isOwn = (pr, viewerLogin) => pr.author.toLowerCase() === viewerLogin.toLowerCase();
