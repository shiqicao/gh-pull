import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

test('removed hosted mode fails closed rather than using local credentials', () => {
  assert.throws(() => createApp({config:{mode:'github-app'}}), /no longer supported/);
});

test('local CLI session exposes version but not control token; hosted routes are absent', async t => {
  const app = createApp({localControl:{version:'v1.2.3',token:'secret'}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const url=`http://127.0.0.1:${app.address().port}`;
  assert.deepEqual(await (await fetch(url+'/api/session')).json(), {mode:'local',authenticated:true,version:{label:'v1.2.3',url:'https://github.com/shiqicao/gh-pull/releases/tag/v1.2.3'}});
  for (const path of ['/auth/login','/auth/callback','/auth/logout','/webhooks/marketplace']) assert.equal((await fetch(url+path)).status,404);
});
