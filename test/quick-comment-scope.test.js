import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuickComment } from '../public/quick-comment-scope.js';

// Rows and columns: omitted, empty, populated non-match, populated match.
const repos = [undefined, [], ['other/api', 'acme/api-tools'], ['other/tools', 'ACME/Api']];
const orgs = [undefined, [], ['acme-tools', 'other'], ['other', 'AcMe']];
const expected = [
  [true,  false, false, true],
  [false, false, false, true],
  [false, false, false, true],
  [true,  true,  true,  true],
];
const names = ['omitted', 'empty', 'miss', 'match'];
for (const [r, repoList] of repos.entries()) {
  for (const [o, orgList] of orgs.entries()) {
    test(`quick comment: repos ${names[r]}, orgs ${names[o]}`, () => {
      const scope = {};
      if (repoList !== undefined) scope.repos = repoList;
      if (orgList !== undefined) scope.orgs = orgList;
      assert.equal(matchesQuickComment(scope, 'acme/api'), expected[r][o]);
    });
  }
}
