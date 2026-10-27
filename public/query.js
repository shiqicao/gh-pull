// Query strings are the persistent search value. No DOM or storage dependencies:
// URLs, presets, and future named searches all use these same operations.
export const DEFAULT_QUERY = 'is:open involves:@me sort:updated-desc';
export const MAX_QUERY_LENGTH = 2000;
const scopeValues = { authored: 'author:@me', involved: 'involves:@me', review: 'review-requested:@me', all: '' };
const stateValues = { open: 'is:open', closed: 'is:closed is:unmerged', merged: 'is:merged', all: '' };
const sortValues = { updated: 'sort:updated-desc', created: 'sort:created-desc', oldest: 'sort:created-asc', review: 'sort:review-status', relevance: '' };
const presets = { scope: scopeValues, state: stateValues, sort: sortValues };

export function tokenizeQuery(query) {
  const tokens = [];
  const pattern = /(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*(?:"|$))+/g;
  for (const match of query.matchAll(pattern)) {
    const raw = match[0];
    const qualifier = /^(-?)([\w-]+):(.*)$/s.exec(raw);
    tokens.push({ raw, from: match.index, to: match.index + raw.length,
      key: qualifier?.[2].toLowerCase() ?? null, negative: qualifier?.[1] === '-',
      value: qualifier?.[3].replace(/^"|"$/g, '').toLowerCase() ?? null });
  }
  return tokens;
}

export function queryError(query) {
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) return `Use a query of at most ${MAX_QUERY_LENGTH} characters.`;
  if (/[\x00-\x1f\x7f]/.test(query)) return 'Use a single line for your query.';
  let quoted = false, escaped = false;
  for (const char of query) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '(' || char === ')')) return 'Boolean groups are not supported yet. Use search qualifiers or quoted phrases.';
  }
  if (quoted) return 'Close the quotation mark before searching.';
  for (const token of tokenizeQuery(query)) {
    if (['AND', 'OR', 'NOT'].includes(token.raw)) return 'Boolean operators are not supported yet. Use search qualifiers or quoted phrases.';
    if (token.key && !token.value) return `Add a value after ${token.key}:`;
    if (token.key === 'type' || (token.key === 'is' && ['pr', 'issue'].includes(token.value))) {
      return 'Pull requests are selected automatically. Remove the type qualifier.';
    }
  }
  return null;
}

export function normalizeQuery(query) {
  const error = queryError(query);
  if (error) throw new Error(error);
  return tokenizeQuery(query).map(t => t.raw).join(' ');
}

// The server, not the editable query, owns the mandatory PR-only restriction.
export function toGitHubQuery(query) {
  const tokens = tokenizeQuery(normalizeQuery(query));
  return ['is:pr', ...tokens.map(t => !t.negative && t.key === 'sort' && t.value === 'review-status' ? 'sort:updated-desc' : t.raw)].join(' ');
}

function belongsTo(token, control) {
  if (control === 'scope') return ['author', 'involves', 'review-requested'].includes(token.key);
  if (control === 'sort') return token.key === 'sort';
  return token.key === 'state' || token.key === 'draft' || (token.key === 'is' && ['open', 'closed', 'merged', 'unmerged', 'draft'].includes(token.value));
}

export function queryPresets(query) {
  const tokens = tokenizeQuery(query);
  return Object.fromEntries(Object.entries(presets).map(([control, values]) => {
    const actual = tokens.filter(t => belongsTo(t, control)).map(t => {
      const key = t.key === 'state' ? 'is' : t.key;
      return `${t.negative ? '-' : ''}${key}:${t.value}`;
    }).sort().join(' ');
    return [control, Object.keys(values).find(value => values[value].split(' ').filter(Boolean).sort().join(' ') === actual) ?? 'custom'];
  }));
}

// Search membership can lag behind a PR's current state. Enforce only the
// state qualifiers we can evaluate from a returned row; GitHub owns the rest.
export function matchesQueryState(pr, query) {
  return tokenizeQuery(query).every(token => {
    let matches;
    if (['is', 'state'].includes(token.key)) {
      if (token.value === 'open') matches = ['OPEN', 'DRAFT'].includes(pr.status);
      if (token.value === 'closed') matches = ['CLOSED', 'MERGED'].includes(pr.status);
      if (token.value === 'merged') matches = pr.status === 'MERGED';
      if (token.value === 'unmerged') matches = pr.status !== 'MERGED';
      if (token.value === 'draft' && ['OPEN', 'DRAFT'].includes(pr.status)) matches = pr.status === 'DRAFT';
    }
    if (token.key === 'draft' && ['true', 'false'].includes(token.value) && ['OPEN', 'DRAFT'].includes(pr.status)) {
      matches = (pr.status === 'DRAFT') === (token.value === 'true');
    }
    return matches === undefined || (token.negative ? !matches : matches);
  });
}

export function setQueryPreset(query, control, value) {
  if (!Object.hasOwn(presets, control) || !Object.hasOwn(presets[control], value)) return query;
  const tokens = tokenizeQuery(query);
  const remaining = tokens.filter(t => !belongsTo(t, control)).map(t => t.raw);
  const addition = presets[control][value];
  if (addition) remaining.push(addition);
  return remaining.join(' ');
}

// Old bookmarks keep their scope/state and text; new URLs need only q + group.
export function queryFromParams(params) {
  if (params.has('q')) {
    // Migrate links from when the fixed PR constraint was shown in the editor.
    return tokenizeQuery(params.get('q')).filter(t => !(!t.negative && ['is', 'type'].includes(t.key) && t.value === 'pr'))
      .map(t => t.raw).join(' ');
  }
  let query = DEFAULT_QUERY;
  for (const control of Object.keys(presets)) {
    if (params.has(control)) query = setQueryPreset(query, control, params.get(control));
  }
  const search = params.get('search')?.trim();
  return search ? `${query} ${search}` : query;
}

const qualifiers = {
  repo: 'Repository', org: 'Organization', user: 'Repository owner', author: 'Author', involves: 'Involving user',
  'review-requested': 'Review requested', 'reviewed-by': 'Reviewed by', 'review-involves': 'Review involves',
  assignee: 'Assignee', mentions: 'Mentioned user', commenter: 'Commenter', label: 'Label',
  is: 'State or visibility', draft: 'Draft status', review: 'Review status', status: 'Commit checks',
  sort: 'Sort order', in: 'Search fields', base: 'Base branch', head: 'Head branch',
  created: 'Created date', updated: 'Updated date', merged: 'Merged date', closed: 'Closed date', comments: 'Comment count',
};
const values = {
  is: ['open', 'closed', 'merged', 'unmerged', 'draft', 'public', 'private'],
  draft: ['true', 'false'], review: ['none', 'required', 'approved', 'changes_requested'],
  status: ['pending', 'success', 'failure'], in: ['title', 'body', 'comments'],
  sort: ['updated-desc', 'updated-asc', 'created-desc', 'created-asc', 'comments-desc', 'comments-asc', 'review-status'],
};
const userKeys = ['author', 'involves', 'review-requested', 'reviewed-by', 'review-involves', 'assignee', 'mentions', 'commenter'];
const quoteValue = value => /[\s"\\]/.test(value) ? JSON.stringify(value) : value;

export function queryCompletions(query, position, items = [], explicit = false) {
  const token = tokenizeQuery(query).find(t => t.from <= position && t.to >= position);
  const from = token?.from ?? position, to = token?.to ?? position;
  const prefix = query.slice(from, position);
  const qualifier = /^(-?)([\w-]+):(.*)$/s.exec(prefix);
  if (!qualifier) {
    if (!explicit && !prefix) return null;
    if (!/^-?[\w-]*$/.test(prefix)) return null;
    const negative = prefix.startsWith('-') ? '-' : '';
    return { from, to, options: Object.entries(qualifiers).map(([key, detail]) => ({ label: `${negative}${key}:`, detail, type: 'keyword' })) };
  }
  const key = qualifier[2].toLowerCase();
  let options = values[key] ?? [];
  if (key === 'repo') options = items.map(pr => pr.repo);
  if (key === 'org' || key === 'user') options = items.map(pr => pr.repo.split('/')[0]);
  if (key === 'label') options = items.flatMap(pr => pr.labels);
  if (key === 'head') options = items.map(pr => pr.branch);
  if (userKeys.includes(key)) options = ['@me', ...items.flatMap(pr => [pr.author, ...(pr.reviewers ?? []).map(r => r.name)]).filter(name => !name.includes('/'))];
  const valueFrom = from + qualifier[1].length + qualifier[2].length + 1;
  return { from: valueFrom, to, options: [...new Set(options.filter(Boolean))].map(value => ({ label: quoteValue(value), type: 'text' })) };
}

// Repository discovery follows people, not the currently narrowed result set.
// Incomplete qualifiers are expected while editing and are ignored here.
export function repositoryScope(query) {
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Invalid autocomplete query.');
  const scopes = tokenizeQuery(query).filter(t => userKeys.includes(t.key) &&
    /^(?:@me|[a-z\d][a-z\d-]*(?:\/[a-z\d][a-z\d-]*)?)$/i.test(t.value ?? ''));
  const terms = scopes.map(t => `${t.negative ? '-' : ''}${t.key}:${t.value}`);
  if (!scopes.some(t => !t.negative)) terms.push('involves:@me');
  return [...new Set(terms)].sort().join(' ');
}
