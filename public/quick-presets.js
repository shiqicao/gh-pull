import { html, render, repeat, nothing } from './vendor/lit-html.js';
import { matchesQuickComment } from './quick-comment-scope.js';
import { presetErrors, orgPattern, repoPattern } from './preset-model.js';
export let presets = [];
let account, editor, deleting, busy=false, status='', retry, undo, errors={};
const $ = id => document.getElementById(id);
const focus = id => $(id)?.focus();
async function request(input) {
  const r = await fetch('/api/quick-comments', input ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...input,account})} : {});
  const data = await r.json(); if (!r.ok) throw Error(data.error || 'Cannot load quick comments.');
  account = data.account; presets = data.presets;
}
export async function loadPresets() { try { await request(); } catch (e) { status=e.message; retry=loadPresets; } draw(); }
let context=null, resume=null, initial='', leavePrompt=false;
export function openSettings(create=false, pr=null, restore=null) {
  reset(); context=pr; resume=restore; draw(); $('settings-modal').showModal();
  if(create)edit();else focus('settings-title');
}
function closeSettings(){if(busy)return;if(editor && JSON.stringify(editor)!==initial){leavePrompt=true;draw();focus('keep-editing');}else $('settings-modal').close();}
function keepEditing(){leavePrompt=false;draw();focus('pf-label');}
function reset(){ editor=null; deleting=null; errors={}; retry=null; undo=null; status=''; }
function edit(p){ reset(); editor={...p,label:p?.label??'',body:p?.body??'', scoped:p?.repos!==undefined||p?.orgs!==undefined,repos:[...(p?.repos??[])],orgs:[...(p?.orgs??[])],pending:{repos:'',orgs:''}};initial=JSON.stringify(editor);draw();focus('pf-label'); }
function cancel(){const id=editor?.id, del=deleting;reset();draw();focus(del?'del-'+del:id?'edit-'+id:'new-preset');}
async function change(input,done){if(busy)return;busy=true;retry=null;status='Saving…';draw();try{await request(input);busy=false;reset();done();}catch(e){busy=false;status=input.action==='save'?`Couldn’t save “${input.label}”. Your changes are still in the form. ${e.message}`:e.message;retry=input.action==='save'?()=>submit():()=>change(input,done);draw();}}
function token(k){const v=editor.pending[k].trim();if(!v)return true;const ok=k==='repos'?repoPattern:orgPattern;
  if(!ok.test(v)) errors[k]=k==='repos'?'Use owner/name, like nyxlabs/nyx.':v.includes('/')?'Enter just the org or user, like nyxlabs. For one repo, add it under Repositories.':'Use an org or user name, like nyxlabs.';
  else if(editor[k].some(x=>x.toLowerCase()===v.toLowerCase()))errors[k]=`${v} is already added.`;
  else{editor[k].push(v);editor.pending[k]='';delete errors[k];delete errors.scope;}draw();focus('pf-'+k);return !errors[k];}
function submit(e){e?.preventDefault();const {id,label,body,scoped}=editor;errors={};if(scoped){for(const k of ['repos','orgs'])token(k);}const p={id,label,body,...(scoped?{repos:editor.repos,orgs:editor.orgs}:{})};errors={...presetErrors(p,presets),...errors};if(Object.keys(errors).length){draw();focus('pf-'+(['label','body','repos','orgs','scope'].find(k=>errors[k])));return;}void change({action:'save',...p},()=>{status=`${id?'Saved':'Added'} “${label.trim()}”.`;draw();focus('edit-'+presets.find(x=>x.label===label.trim()).id);});}
function move(p,delta){void change({action:'move',id:p.id,delta},()=>{status=`Moved “${p.label}” to position ${presets.findIndex(x=>x.id===p.id)+1} of ${presets.length}.`;draw();focus('edit-'+p.id);});}
function remove(p,i){void change({action:'delete',id:p.id},()=>{status=`Deleted “${p.label}”.`;undo=()=>change({action:'restore',...p,position:i},()=>{status=`Restored “${p.label}”.`;draw();focus('edit-'+p.id);});draw();focus('undo-preset');});}
function preview(p){
  if(!p.scoped)return 'Shows on every pull request.';
  const orList=a=>a.length<3?a.join(' or '):a.slice(0,-1).join(', ')+', or '+a.at(-1);
  const parts=[p.repos.length&&orList(p.repos),p.orgs.length&&'any repo owned by '+orList(p.orgs)].filter(Boolean);
  return parts.length?'Shows on PRs in '+parts.join(', or in ')+'.':'Matches no pull requests yet. Add a repository or an org.';
}
function msg(k,help=''){return html`<small class=${errors[k]?'preset-error':'preset-help'} id=${'msg-'+k}>${errors[k]??help}</small>`;}
function icon(path){return html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path}></path></svg>`;}
function tokens(k){return html`<div class="scope-column"><label for=${'pf-'+k}>${k==='repos'?'Repositories owner/name':'Orgs or users (every repo they own)'}</label><div class="scope-input"><input id=${'pf-'+k} aria-invalid=${!!errors[k]} aria-describedby=${'msg-'+k} placeholder=${k==='repos'?'maple-labs/api':'nyxlabs'} .value=${editor.pending[k]} @input=${e=>{editor.pending[k]=e.target.value;delete errors[k];draw();}} @keydown=${e=>{if(e.key==='Enter'){e.preventDefault();token(k);}}}><button type="button" ?disabled=${!editor.pending[k].trim()} @click=${()=>token(k)}>Add</button></div>${msg(k)}${k==='repos'&&context&&!editor.repos.some(v=>v.toLowerCase()===context.repo.toLowerCase())?html`<button type="button" @click=${()=>{editor.pending.repos=context.repo;token('repos');}}>+ ${context.repo}</button>`:nothing}<div class="scope-tags">${editor[k].map(v=>html`<span class="scope-tag" data-repo=${k==='repos'}>${k==='orgs'?'org ':''}${v}<button type="button" aria-label=${'Remove '+v} @click=${()=>{editor[k]=editor[k].filter(x=>x!==v);draw();focus('pf-'+k);}}>${icon('m4 4 8 8m0-8-8 8')}</button></span>`)}</div></div>`;}
function form(){
  const emptyScope=editor.scoped&&!editor.repos.length&&!editor.orgs.length;
  const pendingRepo=editor.pending.repos.trim(), pendingOrg=editor.pending.orgs.trim();
  const validPending=(pendingRepo||pendingOrg)&&(!pendingRepo||repoPattern.test(pendingRepo))&&(!pendingOrg||orgPattern.test(pendingOrg));
  return html`<form class="preset-form" novalidate @submit=${submit}><fieldset ?disabled=${busy}><legend>${editor.id?'Edit':'New'} preset</legend><div class="preset-fields"><div><label for="pf-label">Label</label><input id="pf-label" maxlength="40" placeholder="Build image" aria-invalid=${!!errors.label} aria-describedby="msg-label" .value=${editor.label} @input=${e=>{editor.label=e.target.value;delete errors.label;draw();}}>${msg('label','Shown on the chip. Up to 40 characters.')}</div><div><label for="pf-body">Comment text</label><textarea rows="3" id="pf-body" maxlength="4000" placeholder="[docker-build]" aria-invalid=${!!errors.body} aria-describedby="msg-body" .value=${editor.body} @input=${e=>{editor.body=e.target.value;delete errors.body;draw();}}></textarea>${msg('body','Inserted exactly as written. Markdown works.')}</div></div><fieldset class="scope-choice"><legend>Where it shows</legend>${[false,true].map(s=>html`<label><input type="radio" name="scope" .checked=${s===editor.scoped} @change=${()=>{editor.scoped=s;errors={};draw();if(s)focus('pf-repos');}}> ${s?'Only these repositories and orgs':'Every repository'}</label>`)}</fieldset>${editor.scoped?html`<div class="scope-columns">${tokens('repos')}${tokens('orgs')}</div>`:nothing}<p id="pf-scope" role="status" data-warning=${emptyScope} tabindex="-1">${preview(editor)}</p>${msg('scope')}<div class="preset-actions"><small class="preset-hint-key">Enter adds a repo or org · Esc cancels</small><button type="button" @click=${cancel}>Cancel</button><button class="primary" type="submit" aria-describedby="pf-scope" ?disabled=${busy||(emptyScope&&!validPending)}>${busy?'Saving…':editor.id?'Save preset':'Add preset'}</button></div></fieldset></form>`;}
function row(p,i){if(editor?.id===p.id)return form();if(deleting===p.id)return html`<strong>Delete “${p.label}”?</strong><p>This removes the preset, not any posted comments.</p><button @click=${cancel}>Cancel</button> <button class="preset-error" id="confirm-preset" @click=${()=>remove(p,i)}>Delete preset</button>`;
  const tags=[...(p.repos??[]),...(p.orgs??[]).map(o=>'org '+o)];if(!tags.length)tags.push(p.repos||p.orgs?'No repositories':'All repositories');
  return html`<div class="preset-item"><span class="preset-number">${i+1}</span><div><div class="preset-summary"><strong>${p.label}</strong><code>${p.body}</code></div><small>${context&&matchesQuickComment(p,context.repo)?html`<span class="scope-badge">✓ Shows on ${context.repo.split('/').at(-1)} #${context.number}</span>`:nothing} Shows on ${tags.slice(0,3).map(t=>html`<span class="scope-badge" data-repo=${t.includes('/')}>${t}</span>`)} ${tags.length>3?html`<span title=${tags.slice(3).join(', ')}>+${tags.length-3} more</span>`:nothing}</small></div><div class="preset-actions"><button aria-label=${'Move '+p.label+' up'} ?disabled=${busy||!i} @click=${()=>move(p,-1)}>${icon('m3 10 5-5 5 5')}</button><button aria-label=${'Move '+p.label+' down'} ?disabled=${busy||i===presets.length-1} @click=${()=>move(p,1)}>${icon('m3 6 5 5 5-5')}</button><button id=${'edit-'+p.id} ?disabled=${busy} @click=${()=>edit(p)}>Edit</button><button id=${'del-'+p.id} ?disabled=${busy} @click=${()=>{reset();deleting=p.id;draw();focus('confirm-preset');}}>Delete</button></div></div>`;}
function draw(){if (!$('quick-comment-editor')) return;
  if($('preset-context')){const n=context?presets.filter(p=>matchesQuickComment(p,context.repo)).length:0;$('preset-context').textContent=context?`For your comment on ${context.repo.split('/').at(-1)} #${context.number} · ${n===0?'No presets show on this PR yet.':n===1?'1 preset shows on this PR.':`${n} presets show on this PR.`}`:'';}
  render(html`${leavePrompt?html`<div class="discard-preset" role="alert"><strong>${editor?.id?`Discard your changes to “${presets.find(p=>p.id===editor.id)?.label}”?`:'Discard this new preset? It hasn’t been saved.'}</strong><button id="keep-editing" @click=${keepEditing}>Keep editing</button><button @click=${()=>$('settings-modal').close()}>Discard and leave</button></div>`:nothing}<div class="preset-heading"><div>${$('settings-modal')?html`<h3>Quick comment presets</h3>`:html`<h1>Quick comment presets</h1>`}<p>One click fills the Quick comment draft with text you post often. Nothing is posted until you press Post comment. Presets show in this order, and only on PRs inside their scope.</p></div>${presets.length?html`<button class="primary" id="new-preset" ?disabled=${busy} @click=${()=>edit()}>${icon('M8 2v12M2 8h12')} Add preset</button>`:nothing}</div><div class="preset-status" role="status">${status || (presets.length ? `${presets.length} preset${presets.length===1?'':'s'}. Changes save automatically.`:'')} ${retry?html`<button @click=${retry}>Retry</button>`:undo?html`<button id="undo-preset" @click=${undo}>Undo</button>`:nothing}</div>${!presets.length&&!editor?html`<div class="preset-empty"><strong>No presets yet</strong><p>Save comments you post often, like [docker-build] or @claude_review.</p><button class="primary" id="new-preset" @click=${()=>edit()}>Create your first preset</button></div>`:nothing}<ol class="preset-list">${editor&&!editor.id?html`<li>${form()}</li>`:nothing}${repeat(presets,p=>p.id,(p,i)=>html`<li>${row(p,i)}</li>`)}</ol>`,$('quick-comment-editor'));}
if ($('settings-modal')) {
  const modal=$('settings-modal');
  $('settings').onclick=()=>openSettings(); $('dismiss-settings').onclick=closeSettings;
  modal.addEventListener('cancel',e=>{e.preventDefault();if(leavePrompt)keepEditing();else closeSettings();});
  let pressedOutside=false;
  function outside(e){const r=modal.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;}
  modal.addEventListener('pointerdown',e=>{pressedOutside=outside(e);});
  modal.addEventListener('pointerup',e=>{if(pressedOutside&&outside(e))closeSettings();pressedOutside=false;});
  modal.addEventListener('close',()=>{leavePrompt=false;context=null;reset();const back=resume;resume=null;if(back)back();else focus('settings');});
} else if ($('quick-comment-editor')) {
  $('dashboard-link').href = '/' + location.search;
  document.addEventListener('keydown', e=>{if(e.key==='Escape'&&!busy&&(editor||deleting)){e.preventDefault();cancel();}});
  void loadPresets().then(()=>{if(location.hash==='#new')edit();});
}
