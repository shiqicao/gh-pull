export const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const orgPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export function presetErrors(p, others) {
  const errors = {};
  if (typeof p.label !== 'string' || !p.label.trim()) errors.label = 'Enter a label.';
  else if (p.label.trim().length > 40) errors.label = 'Use at most 40 characters.';
  else if (others.some(x => x.id !== p.id && x.label.toLowerCase() === p.label.trim().toLowerCase())) errors.label = `A preset named “${p.label.trim()}” already exists.`;
  if (typeof p.body !== 'string' || !p.body.trim()) errors.body = 'Enter the comment text to insert.';
  else if (p.body.length > 4000) errors.body = 'Use at most 4000 characters.';
  for (const [key, pattern, message] of [['repos', repoPattern, 'Use owner/name, like nyxlabs/nyx.'], ['orgs', orgPattern, 'Use an org or user name, like nyxlabs.']]) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].some(x => typeof x !== 'string' || !pattern.test(x)))) errors[key] = message;
  }
  if ((p.repos !== undefined || p.orgs !== undefined) && !p.repos?.length && !p.orgs?.length) errors.scope = 'Add a repository or an org, or choose Every repository.';
  return errors;
}
export function insertPreset(draft, body) { return draft.includes(body) ? draft : draft.trim() ? `${draft.trimEnd()}\n${body}` : body; }
