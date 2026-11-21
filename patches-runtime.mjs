// The runtime-side patch for the two extension bundles: reasoning effort and
// the context window on the outgoing request, plus the shared subagent and
// action handling. Shared so the same code patches the client bundles and,
// through scripts/install-remote.mjs, the copy under ~/.cursor-server on an
// SSH host.
import {patchSubagentSettingsRuntime} from './subagent-settings.mjs';
import {patchFusionRuntime} from './fusion.mjs';
import {patchSubagentModel} from './subagent-model.mjs';
import {patchConversationActionsRuntime} from './conversation-actions.mjs';

const prefix = 'claude-subscription/';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Patch anchor not unique: ' + before.slice(0, 100));
  return source.replace(before, after);
}

export function patchRuntime(source) {
  // Cursor 3.21.1 rotated the minified locals and the two runtime bundles no
  // longer agree on them, so read the parameter list variable off the anchor.
  // The Fusion branch, when the other link added it, sits between the two.
  const anchor = source.match(/\}\(([\w$]+)\);(?:if\(typeof t==="string"&&\/\^\(chatgpt-codex\|claude-subscription\)\\\/fusion\$\/\.test\(t\)\)\{[^}]*\})?if\(typeof t==="string"&&t\.startsWith\("chatgpt-codex\/"\)\)/)
    ?? source.match(/\}\(([\w$]+)\);if\(void 0===a\)return;if\(void 0!==i&&"openai_compatible"===[\w$]+\)/);
  const branch = params => 'if(typeof t==="string"&&t.startsWith("claude-subscription/")){const selected=' + params + '?.find(p=>p.id==="reasoning")?.value;if(selected!==undefined)e.reasoning={...e.reasoning,effort:selected};const context=' + params + '?.find(p=>p.id==="context")?.value;if(context!==undefined)e.claude_context=Number(context);delete e.reasoning_effort;delete e.service_tier;return}';
  let params;
  if (anchor) {
    params = anchor[1];
    source = once(source, anchor[0], '}(' + params + ');' + branch(params) + anchor[0].slice(('}(' + params + ');').length));
  } else {
    // Any order of the links: on an SSH host the other links may already have
    // put their branches here. The effort normalisation that ends right before
    // all of them is the same in every state.
    const all = [...source.matchAll(/"none"===([\w$]+)\?void 0:\1\}\(([\w$]+)\);/g)];
    if (all.length !== 1) throw new Error('Reasoning effort anchor missing.');
    params = all[0][2];
    source = once(source, all[0][0], all[0][0] + branch(params));
  }
  const api = source.match(/([\w$]+)\.includes\("codex"\)(\|\|\1\.startsWith\("claude-subscription\/"\))?\?"responses":"chat_completions"/);
  if (!api) throw new Error('Local API type heuristic missing.');
  if (!api[2]) source = once(source, api[0], api[1] + '.includes("codex")||' + api[1] + '.startsWith("claude-subscription/")?"responses":"chat_completions"');
  source = patchFusionRuntime(source, params);
  return patchConversationActionsRuntime(patchSubagentSettingsRuntime(patchSubagentModel(source)), prefix);
}
