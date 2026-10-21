import {
  EditorState, Prec, EditorView, Decoration, ViewPlugin, keymap, placeholder,
  history, historyKeymap, defaultKeymap,
  autocompletion, completionKeymap, acceptCompletion, closeCompletion,
} from './vendor/codemirror.js';
import { tokenizeQuery, queryCompletions, queryError, repositoryScope } from './query.js';

function highlights(view) {
  const marks = [];
  for (const token of tokenizeQuery(view.state.doc.toString())) {
    if (!token.key) continue;
    const colon = token.from + token.raw.indexOf(':');
    marks.push(Decoration.mark({ class: 'query-key' }).range(token.from, colon + 1));
    if (colon + 1 < token.to) marks.push(Decoration.mark({ class: token.value === '@me' ? 'query-me' : 'query-value' }).range(colon + 1, token.to));
  }
  return Decoration.set(marks);
}

export function createQueryEditor({ parent, value, onChange, onSubmit, getItems, getRepositories }) {
  const repositoryRequests = new Map();
  let repositoryRevision = 0;
  const localCompletions = context => queryCompletions(context.state.doc.toString(), context.pos, getItems(), context.explicit);
  async function repositoryCompletions(context) {
    const revision = repositoryRevision;
    const query = context.state.doc.toString();
    const result = queryCompletions(query, context.pos, getItems(), context.explicit);
    const token = tokenizeQuery(query).find(t => t.from <= context.pos && t.to >= context.pos);
    if (!result || token?.key !== 'repo' || context.pos <= token.from + token.raw.indexOf(':') || !getRepositories) return null;
    context.addEventListener('abort', () => {}, { onDocChange: true });
    try {
      const scope = repositoryScope(query);
      let cached = repositoryRequests.get(scope);
      if (!cached || cached.until < Date.now()) {
        const promise = getRepositories(scope);
        cached = { promise, until: Date.now() + 5 * 60_000 };
        repositoryRequests.set(scope, cached);
        if (repositoryRequests.size > 20) repositoryRequests.delete(repositoryRequests.keys().next().value);
        promise.catch(() => { if (repositoryRequests.get(scope) === cached) repositoryRequests.delete(scope); });
      }
      const data = await cached.promise;
      if (context.aborted || revision !== repositoryRevision) return null;
      // CodeMirror combines both sources. Local results are visible while this
      // request is pending; remote results only add repositories not already shown.
      const loaded = new Set(result.options.map(option => option.label));
      return { ...result, options: [...new Set(data.repositories)].filter(repo => !loaded.has(repo)).map(repo => ({ label: repo, type: 'text',
        detail: data.limited ? 'Recent repositories (partial list)' : data.source === 'me' ? 'Your repositories' : undefined,
      })) };
    } catch { return null; /* Local suggestions remain available. */ }
  }
  const editor = new EditorView({
    parent,
    state: EditorState.create({ doc: value, extensions: [
      EditorView.cspNonce.of(document.querySelector('meta[name="style-nonce"]').content),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(view => ({ role: 'textbox', 'aria-label': 'Search pull requests', 'aria-describedby': 'query-help query-feedback', 'aria-multiline': 'false', 'aria-invalid': String(Boolean(queryError(view.state.doc.toString()))), autocapitalize: 'off', spellcheck: 'false' })),
      placeholder('is:open involves:@me'),
      history(),
      EditorState.transactionFilter.of(tr => {
        if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
        // Pasting a multiline query keeps the search field on one logical line.
        const doc = tr.newDoc.toString().replace(/[\r\n]+/g, ' ');
        return { changes: { from: 0, to: tr.startState.doc.length, insert: doc }, selection: { anchor: Math.min(tr.newSelection.main.head, doc.length) } };
      }),
      ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = highlights(view); }
        update(update) { if (update.docChanged) this.decorations = highlights(update.view); }
      }, { decorations: plugin => plugin.decorations }),
      autocompletion({
        override: [localCompletions, repositoryCompletions],
        updateSyncTime: 0,
        activateOnTypingDelay: 80, interactionDelay: 0, defaultKeymap: false, icons: false,
        activateOnCompletion: completion => completion.label.endsWith(':'),
      }),
      Prec.highest(keymap.of([
        { key: 'Enter', run(view) { if (!acceptCompletion(view)) onSubmit(); return true; } },
        { key: 'Escape', run: closeCompletion },
        { key: 'Tab', run: acceptCompletion },
        ...completionKeymap.filter(binding => !['Enter', 'Escape'].includes(binding.key)),
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); }),
    ] }),
  });
  return {
    clearRepositoryCache() { repositoryRequests.clear(); repositoryRevision++; },
    get value() { return editor.state.doc.toString(); },
    setValue(next) {
      if (next !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next } });
    },
    focus() { editor.focus(); },
    closeSuggestions() { closeCompletion(editor); },
  };
}
