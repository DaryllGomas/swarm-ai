// Screening for project text that ends up in task briefs. Contributors' AIs read these briefs, so text from outside
// (public issues, objections, plan steps) is treated as hostile: links, emails and @handles are stripped, and anything
// that looks like an instruction aimed at an AI makes the whole task "held" (never served; visible to the admin).
// Adapted from Town Hall's screen() in its worker. Pure functions, no I/O.
import { clean } from './lib.js';

const HIDDEN = /[​-‏‪-‮⁠-⁩﻿]/;
const HIDDEN_ALL = /[​-‏‪-‮⁠-⁩﻿]/g;

// Bare domains with common endings ("benefits.gov", "example.com/path"). Not exhaustive on purpose: real links are
// caught by the https?:// and www. rules; this just stops a bare domain from slipping through as a "hint".
const BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|ru|gov|edu|info|app|dev|biz|top|tk|cc)\b(?:\/[^\s)>\]]*)?/gi;

// Remove links, emails and @handles. Order matters: emails first (they contain domains).
export function stripLinks(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]')
    .replace(/\b(?:https?|ftp|file|data|javascript):[^\s)>\]]*/gi, '[link removed]')
    .replace(/\bwww\.[^\s)>\]]*/gi, '[link removed]')
    .replace(BARE_DOMAIN, '[link removed]')
    .replace(/(?<![\w/@.])@[A-Za-z0-9_]{2,30}\b/g, '[handle removed]');
}

// Clean project text for a brief: strip links, drop control and hidden characters, flatten whitespace, cut to `max`.
// Long runs of rule characters are collapsed so text cannot fake the data markers around it.
export function sanitize(text, max) {
  return clean(stripLinks(String(text ?? '').replace(HIDDEN_ALL, '')), max * 2)
    .replace(/([-=_*#~])\1{2,}/g, '$1')
    .slice(0, max)
    .trim();
}

// [name, pattern]. Names are stored as the held reason, so they stay short and never contain the matched text.
const PATTERNS = [
  ['ignore_instructions', /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|preceding|your|all|any)\s+(?:\w+\s+)?(?:instructions?|prompts?|directions|programming)\b/i],
  ['role_override', /\byou are (?:now|no longer)\b|\bfrom now on,? you\b|\bact as (?:if you (?:are|were)|an? (?:ai|assistant|system|developer|admin))\b|\bpretend (?:to be|you are)\b|\byour new (?:instructions?|role|persona|task)\b/i],
  ['system_prompt', /\bsystem prompts?\b|\bsystem message\b|\bdeveloper message\b|\bdeveloper mode\b|\bjailbreak\b|\bDAN mode\b/i],
  ['run_command', /\b(?:run|execute|paste|type|enter|copy)\b[^.\n]{0,30}\b(?:this|the following|these|below)\b[^.\n]{0,25}\b(?:commands?|scripts?|code|snippets?|terminal|shell)\b/i],
  ['shell_command', /\b(?:curl|wget|powershell|sudo|chmod|chown)\b|\|\s*(?:ba|z|da|k)?sh\b|\b(?:bash|sh|zsh)\s+-[a-z]\b|\brm\s+-[rf]+\b|\bpython3?\s+-c\b|\b(?:eval|exec)\s*\(|\bnpm\s+(?:i|install)\b|\bpip3?\s+install\b|\bgit\s+clone\b/i],
  ['encoded_blob', /[A-Za-z0-9+/]{40,}={0,2}|\bbase64\b|\batob\s*\(/i],
  ['secret_request', /\bswk_[A-Za-z0-9_-]{8,}|\b(?:send|post|paste|reveal|upload|email|include)\b[^.\n]{0,40}\b(?:api[ _-]?keys?|passwords?|passphrases?|secrets?|credentials?|private keys?|seed phrases?|contributor keys?)\b/i],
  ['open_link_request', /\b(?:open|visit|click|go to|navigate to|download|install|fetch|load)\b[^.\n]{0,30}\b(?:this|the following|that|these)\s+(?:\w+\s+)?(?:links?|urls?|sites?|websites?|pages?|files?|packages?|extensions?|attachments?)\b/i],
  ['conceal_from_user', /\b(?:do not|don't|never|without)\b[^.\n]{0,20}\b(?:tell|telling|inform|informing|mention|reveal|show|disclose)\b[^.\n]{0,30}\b(?:user|owner|human|operator|person)\b/i],
  ['aimed_at_ai', /(?:return|output|respond|reply|answer)(?: with)? only\b|\bthis (?:task|post|message|submission|text) (?:must|should|is to) be (?:approved|accepted|published)\b|\b(?:approve|accept) (?:this|my) (?:submission|work)\b|\b(?:authori[sz]ed|approved) by the (?:evaluator|moderator|admin|developer|operator)s?\b|\b(?:dear|attention|note to) (?:the )?(?:ai|assistant|agent|model|llm|moderator|evaluator)\b|\b(?:to|for) (?:the |any )?(?:ai|llm|language model|assistant|agent)s? (?:reading|reviewing|processing)\b/i],
  ['json_payload', /\{[^{}]*"\w+"\s*:/],
  ['chat_markers', /<\|[a-z_]+\|>|\[\/?INST\]|^\s*(?:system|assistant)\s*:|###\s*(?:system|instruction)/im],
  ['data_marker_spoof', /(?:BEGIN|END)\s+PROJECT\s+DATA/i],
  ['markup', /<\s*(?:script|iframe|img|svg|style|link|object|embed)\b|javascript:|data:text\/html/i],
];

// Names of the injection patterns the text trips (empty array = looks fine). Looks at the raw text and at a normalized
// copy (hidden characters removed, Unicode folded), so "ig​nore previous instructions" is still caught.
export function injectionFlags(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const flags = new Set();
  if (HIDDEN.test(raw)) flags.add('hidden_characters');
  const normalized = raw.replace(HIDDEN_ALL, '').normalize('NFKC');
  for (const [name, re] of PATTERNS) if (re.test(raw) || re.test(normalized)) flags.add(name);
  return [...flags];
}

// Collects the injection flags of everything that goes into one task's brief.
// t(value, max) returns the cleaned text and remembers any flags raised by the raw value.
export function makeScreen() {
  const flags = new Set();
  return {
    flags,
    t(value, max) {
      for (const f of injectionFlags(value)) flags.add(f);
      return sanitize(value, max);
    },
    get held() { return flags.size > 0; },
    get reason() { return [...flags].join(', '); },
  };
}

// Town Hall plan steps cite a file in its public repository. Only that exact kind of link is kept, and only as a
// repository path (never a clickable address) so no URL from project text ever reaches an agent.
const TH_REPO_FILE = /^https:\/\/github\.com\/DaryllGomas\/town-hall\/blob\/main\/(problems\/[A-Za-z0-9_./-]{1,200})$/;
export function repoPathFromEvidence(url) {
  const m = TH_REPO_FILE.exec(String(url ?? '').trim());
  return m && !m[1].includes('..') ? m[1] : '';
}
