import { contrastRatio, normalizeHex, requiredContrast } from './contrast.ts';

/**
 * Rules a person sets once per site. The agent can read them but never change them.
 * Every variant must pass `checkVariant` before it gets any traffic.
 */
/** One place the agent may touch. */
export interface Slot {
  kinds: Array<'text' | 'order' | 'style' | 'attr'>;
  maxChars?: number;
  /** For kind "attr": which attributes may be set here, and the only values each may take. Names start with data-. */
  attrs?: Record<string, string[]>;
}

export interface Policy {
  /** The only places the agent may touch, and what it may do in each. */
  slots: Record<string, Slot>;
  /** Selectors containing any of these words are never touched, even if someone allowlists them by mistake. */
  neverChange: string[];
  facts: {
    /** Numbers the copy may mention, written as they would appear: "4 weeks", "30%", "$49". */
    numbers: string[];
    /** Claims the copy may make: "free", "certified", "thousands of learners". */
    claims: string[];
  };
  brand: {
    colors: string[];
    fonts: string[];
    minFontPx: number;
    maxFontPx: number;
    forbiddenWords: string[];
  };
}

export interface Proposal {
  selector: string;
  kind: 'text' | 'order' | 'style' | 'attr';
  text?: string;
  /** For kind "attr": a data- attribute and one of the values the policy lists for it. */
  attr?: string;
  value?: string;
  /** For kind "order": the new order, and the order the page has today. */
  order?: string[];
  originalOrder?: string[];
  style?: { color?: string; background?: string; fontFamily?: string; fontSizePx?: number };
  /** How the element looks today, used to check contrast when the proposal changes only some of it. Not needed for kind "attr" or "order". */
  context?: { color: string; background: string; fontSizePx: number; bold?: boolean };
}

/** Attribute names an experiment may set: data- attributes only, so nothing that loads, runs or links can be switched. */
export const ATTR_NAME_RE = /^data-[a-z][a-z0-9-]{0,40}$/;
export const ATTR_VALUE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type CheckName = 'scope' | 'facts' | 'brand' | 'readability' | 'honesty';

export interface CheckResult {
  ok: boolean;
  failures: Array<{ check: CheckName; reason: string }>;
}

const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30', forty: '40', fifty: '50',
};

const WORDS = Object.keys(NUMBER_WORDS).join('|');
const UNIT = '(?:%|€|\\$|£|֏|(?:amd|usd|eur|weeks?|days?|hours?|minutes?|months?|years?|lessons?|projects?|x)\\b)';
const NUMBER_RE = new RegExp(`([$€£֏])?\\s*(?:\\b(${WORDS})\\b|(\\d[\\d.,]*\\d|\\d))\\s*(${UNIT})?`, 'gi');

const QUANTITY_RE = /\b(thousands|millions|hundreds|dozens|countless)\b/gi;
const SUPERLATIVE_RE = /(?:\b(best|leading|top[- ]rated|guaranteed?|certified|proven|award[- ]winning|official|free|number one)\b|#1)/gi;
const DATE_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

const HONESTY: Array<[RegExp, string]> = [
  [/\bonly\s+\d+\s+(?:\w+\s+)?(?:left|remaining|spots?|seats?|places?)\b/i, 'invented scarcity'],
  [/\b(?:last chance|hurry|act now|don'?t miss out|selling fast|going fast|while (?:stocks|supplies) last)\b/i, 'false urgency'],
  [/\b(?:ends|expires?|offer ends|deadline)\b.*\b(?:today|tonight|tomorrow|soon|midnight|\d)/i, 'a deadline the site cannot back up'],
  [/\blimited[- ](?:time|spots?|seats?|offer)\b/i, 'invented scarcity'],
  [/\b(?:save|off|discount|deal|sale)\b.*\bthis (?:week|weekend|month)\b/i, 'a time-limited offer the site cannot back up'],
  [/\b(?:\d+\s+people (?:are )?(?:viewing|watching|looking)|just (?:bought|signed up|enrolled))\b/i, 'invented live activity'],
];

interface NumberToken {
  num: string;
  unit: string;
  /** The text as it appeared, for messages. */
  raw: string;
}

function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const num = m[2] ? NUMBER_WORDS[m[2].toLowerCase()] : (m[3] ?? '').replace(/,/g, '');
    const unit = (m[1] ?? m[4] ?? '').toLowerCase().replace(/s$/, '');
    out.push({ num, unit, raw: m[0].trim() });
  }
  return out;
}

function isApproved(n: NumberToken, approved: NumberToken[]): boolean {
  return approved.some((a) => a.num === n.num && (a.unit === n.unit || n.unit === ''));
}

export function checkVariant(p: Proposal, policy: Policy): CheckResult {
  const failures: CheckResult['failures'] = [];
  const fail = (check: CheckName, reason: string) => failures.push({ check, reason });

  // 1. Scope
  const slot = policy.slots[p.selector];
  if (!slot) fail('scope', `${p.selector} is not a place you allowed`);
  else if (!slot.kinds.includes(p.kind)) fail('scope', `${p.selector} does not allow ${p.kind} changes`);
  const locked = policy.neverChange.find((w) => p.selector.toLowerCase().includes(w.toLowerCase()));
  if (locked) fail('scope', `${p.selector} touches something that never changes (${locked})`);
  if (p.kind === 'text') {
    if (!p.text || p.text.trim() === '') fail('scope', 'empty text');
    if (p.text && /[<>]/.test(p.text)) fail('scope', 'text contains markup');
    if (p.text && /(?:https?:\/\/|www\.|href\s*=|\bmailto:)/i.test(p.text)) fail('scope', 'text contains a link');
  }
  if (p.kind === 'attr') {
    const name = p.attr ?? '';
    const value = p.value ?? '';
    if (!ATTR_NAME_RE.test(name)) fail('scope', `"${name}" is not a data- attribute`);
    else {
      const allowedValues = slot?.attrs?.[name];
      if (slot && !allowedValues) fail('scope', `${p.selector} does not allow changing ${name}`);
      else if (allowedValues && !ATTR_VALUE_RE.test(value)) fail('scope', `"${value}" is not a plain value`);
      else if (allowedValues && !allowedValues.includes(value)) fail('scope', `${name}="${value}" is not one of the values you allowed (${allowedValues.join(', ')})`);
    }
  }
  if (p.kind === 'order') {
    const o = p.order ?? [];
    const orig = p.originalOrder ?? [];
    if (new Set(o).size !== o.length) fail('scope', 'order repeats an item');
    if (o.some((x) => !orig.includes(x))) fail('scope', 'order adds an item that is not on the page');
  }

  if (p.kind === 'text' && p.text) {
    const text = p.text;

    // 2. Facts
    const allowed = policy.facts.numbers.flatMap((f) => numbersIn(f));
    for (const n of numbersIn(text)) {
      if (!isApproved(n, allowed)) fail('facts', `"${n.raw}" is not in your facts`);
    }
    const claims = policy.facts.claims.map((c) => c.toLowerCase());
    for (const m of text.matchAll(QUANTITY_RE)) {
      if (!claims.some((c) => c.includes(m[1].toLowerCase()))) fail('facts', `a new claim ("${m[1].toLowerCase()}"), not in your facts`);
    }
    for (const m of text.matchAll(SUPERLATIVE_RE)) {
      const word = (m[1] ?? m[0]).toLowerCase();
      if (!claims.some((c) => c.includes(word))) fail('facts', `a new claim ("${word}"), not in your facts`);
    }
    for (const m of text.matchAll(DATE_RE)) {
      fail('facts', `a date or deadline ("${m[1].toLowerCase()}") that is not in your facts`);
    }

    // 5. Honesty
    for (const [re, label] of HONESTY) if (re.test(text)) fail('honesty', label);

    // 3. Brand voice
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8 && letters === letters.toUpperCase()) fail('brand', 'all capitals');
    const lower = text.toLowerCase();
    for (const w of policy.brand.forbiddenWords) if (lower.includes(w.toLowerCase())) fail('brand', `uses a word the brand avoids ("${w}")`);

    // 4. Readability: length
    if (slot?.maxChars !== undefined && text.length > slot.maxChars) fail('readability', `${text.length} characters, over the ${slot.maxChars} that fit`);
  }

  // Text and style changes are judged against how the element looks today.
  const ctx = p.context;
  if ((p.kind === 'style' || p.kind === 'text') && !ctx) fail('readability', 'does not say how the element looks today (context), so contrast cannot be checked');

  // 3. Brand tokens and 4. contrast, for style changes
  if (p.kind === 'style' && p.style && ctx) {
    const colors = policy.brand.colors.map((c) => normalizeHex(c));
    for (const key of ['color', 'background'] as const) {
      const v = p.style[key];
      if (v === undefined) continue;
      const hex = normalizeHex(v);
      if (!hex || !colors.includes(hex)) fail('brand', `${key} ${v} is not one of your brand colours`);
    }
    if (p.style.fontFamily !== undefined && !policy.brand.fonts.some((f) => f.toLowerCase() === p.style!.fontFamily!.toLowerCase())) {
      fail('brand', `font ${p.style.fontFamily} is not one of your brand fonts`);
    }
    const size = p.style.fontSizePx ?? ctx.fontSizePx;
    if (size < policy.brand.minFontPx || size > policy.brand.maxFontPx) fail('brand', `${size}px is outside ${policy.brand.minFontPx} to ${policy.brand.maxFontPx}px`);
  }
  if ((p.kind === 'style' || p.kind === 'text') && ctx) {
    const fg = p.style?.color ?? ctx.color;
    const bg = p.style?.background ?? ctx.background;
    if (normalizeHex(fg) && normalizeHex(bg)) {
      const ratio = contrastRatio(fg, bg);
      const need = requiredContrast(p.style?.fontSizePx ?? ctx.fontSizePx, ctx.bold ?? false);
      if (ratio < need) fail('readability', `contrast ${ratio.toFixed(1)}:1 is below the ${need}:1 minimum`);
    }
  }

  return { ok: failures.length === 0, failures };
}
