// Screening for project text that ends up in task briefs. Contributors' AIs read these briefs, so text from outside
// (public issues, objections, plan steps) is treated as hostile: links, emails and @handles are stripped, and anything
// that looks like an instruction aimed at an AI makes the whole task "held" (never served; visible to the admin).
// Adapted from Town Hall's screen() in its worker. Pure functions, no I/O.
import { clean } from './lib.js';

// Characters we flag as "hidden" when they show up in project text: zero-width and direction marks, NUL and other
// control characters (tab, newline and carriage return are ordinary), and Unicode tag characters.
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\u{E0000}-\u{E007F}]/u;

// Characters removed outright by normalizeText: every control character except \n and \t, every format character
// (Cf: zero-width, direction marks, soft hyphen, word joiners, BOM, tag characters), variation selectors, and the
// invisible filler letters.
const STRIP_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const STRIP_INVISIBLE = /[\p{Cf}\ufe00-\ufe0f\u180b-\u180d\u115f\u1160\u3164\uffa0]/gu;

// Normalize project text before anything looks at it, so what is screened is exactly what could be served:
// NFKC, controls and invisible characters removed, line/paragraph separators turned into newlines, whitespace collapsed.
// `controlsAs` is what a removed control character leaves behind: '' for the text that is served, ' ' for the
// matching-only variant that treats a control character as a separator.
function stripped(text, controlsAs = '') {
  return String(text ?? '').normalize('NFKC').replace(/[\u2028\u2029]/g, '\n').replace(STRIP_CONTROL, controlsAs).replace(STRIP_INVISIBLE, '');
}
function collapse(s) {
  return s.replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
}
export function normalizeText(text) {
  return collapse(stripped(text));
}

// Lookalike letters (Cyrillic, Greek, IPA small capitals) mapped to the Latin letter they imitate. Matching only: the
// served text keeps the original letters.
const LOOKALIKES = {};
for (const [latin, like] of Object.entries({
  a: 'а α ᴀ', b: 'ь β ʙ', c: 'с ϲ ᴄ', d: 'ԁ ᴅ', e: 'е ε ᴇ', g: 'ɡ', h: 'һ ʜ', i: 'і ι ɪ ı', j: 'ј ᴊ', k: 'к κ ᴋ', l: 'ӏ ʟ', m: 'м ᴍ', n: 'η ɴ', o: 'о ο ᴏ σ',
  p: 'р ρ ᴘ', q: 'ԛ', r: 'ʀ', s: 'ѕ ꜱ', t: 'т τ ᴛ', u: 'υ ᴜ', v: 'ѵ ν ᴠ', w: 'ԝ ѡ ᴡ', x: 'х χ', y: 'у γ ʏ', z: 'ᴢ',
  A: 'А Α', B: 'В Β', C: 'С Ϲ', E: 'Е Ε', H: 'Н Η', I: 'І Ι', J: 'Ј', K: 'К Κ', M: 'М Μ', N: 'Ν', O: 'О Ο', P: 'Р Ρ', S: 'Ѕ', T: 'Т Τ', X: 'Х Χ', Y: 'У Υ', Z: 'Ζ',
})) for (const ch of like.split(' ')) LOOKALIKES[ch] = latin;
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');
function fold(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]);
}

// "i g n o r e", "i.g.n.o.r.e", "i-g-n-o-r-e": runs of single letters, one separator apart, joined into one word.
// Done before whitespace is collapsed, so a wider gap (two or more spaces) still marks the end of a word.
const SPLIT_RUN = /(?<![\p{L}\p{N}])\p{L}(?:[ .\-_*·•|/]\p{L}){2,}(?![\p{L}\p{N}])/gu;
const joinSplit = (s) => s.replace(SPLIT_RUN, (run) => run.replace(/[ .\-_*·•|/]/g, ''));
const HAS_SPLIT_RUN = /(?<![\p{L}\p{N}])\p{L}(?:[ .\-_*·•|/]\p{L}){3,}(?![\p{L}\p{N}])/u;

// For text that spells things out letter by letter with single spaces everywhere ("i g n o r e   p r e v ..." where even
// the word gaps shrink to one space), word boundaries are lost, so the key phrases are also looked for with every
// non-letter removed. Only tried on text that actually contains a split-letter run, to keep false positives rare.
const SQUASHED = [
  ['ignore_instructions', /(?:ignore|disregard|forget|override)(?:all|any|your|the)?(?:previous|prior|above|earlier|preceding)(?:instructions?|prompts?|directions|programming)/],
  ['role_override', /youarenow|youarenolonger|fromnowonyou|pretendtobe|pretendyouare|yournew(?:instructions?|role|persona|task)/],
  ['system_prompt', /systemprompts?|systemmessage|developermessage|developermode|jailbreak|danmode/],
  ['run_command', /(?:run|execute|paste|type|enter|copy)(?:this|thefollowing|these|below)(?:commands?|scripts?|code|snippets?|terminal|shell)/],
];

// Every form of the text the patterns are tried against. The first is the exact text that would be served.
function screenVariants(raw) {
  const out = new Set([raw]);
  for (const controlsAs of ['', ' ']) {
    const base = stripped(raw, controlsAs);
    for (const form of [base, fold(base)]) {
      for (const joined of [form, joinSplit(form)]) {
        const c = collapse(joined);
        out.add(c);
        out.add(c.replace(/\n/g, ' '));
      }
    }
  }
  return out;
}
const SQUASH_DROP = /[^a-z]/g;

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

// Clean project text for a brief: normalize it (see normalizeText), strip links, flatten whitespace, cut to `max`.
// This is the only form of project text that is ever served; the raw text is only ever looked at, never passed on.
// Long runs of rule characters are collapsed so text cannot fake the data markers around it.
export function sanitize(text, max) {
  return clean(stripLinks(normalizeText(text)), max * 2)
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

// Names of the injection patterns the text trips (empty array = looks fine). The text is normalized FIRST (controls and
// invisible characters removed or turned into separators, Unicode folded, lookalike letters mapped to Latin, spelled-out
// letters joined) and every one of those forms is screened, so "ig\u200bnore previous\u0000instructions" and
// "i g n o r e previous instructions" are caught the same as the plain phrase.
export function injectionFlags(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const flags = new Set();
  if (HIDDEN.test(raw)) flags.add('hidden_characters');
  const variants = screenVariants(raw);
  for (const [name, re] of PATTERNS) for (const v of variants) if (re.test(v)) { flags.add(name); break; }
  const folded = fold(collapse(stripped(raw)));
  if (HAS_SPLIT_RUN.test(folded) || HAS_SPLIT_RUN.test(fold(collapse(stripped(raw, ' '))))) {
    const squashed = [...variants].map((v) => fold(v).toLowerCase().replace(SQUASH_DROP, ''));
    for (const [name, re] of SQUASHED) if (squashed.some((q) => re.test(q))) flags.add(name);
  }
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
      const served = sanitize(value, max);
      // Stripping links, collapsing rule characters and cutting to length can leave new word runs: screen what is served too.
      for (const f of injectionFlags(served)) flags.add(f);
      return served;
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
