// An entirely unscoped preset is global. Once scoped, either list can grant a match.
export function matchesQuickComment({ repos, orgs }, repository) {
  if (repos === undefined && orgs === undefined) return true;
  const repo = repository.toLowerCase();
  const owner = repo.split('/')[0];
  return Boolean(repos?.some(name => name.toLowerCase() === repo) || orgs?.some(name => name.toLowerCase() === owner));
}
