import { checkVariant } from '../safety/policy.ts';
import type { Policy } from '../safety/policy.ts';
import { makeConfig } from '../core/types.ts';
import type { Config, DeepPartial } from '../core/types.ts';
import { VARIANT_RE, cleanPath, newKey } from './http.ts';
import { CONTROL_ID } from './types.ts';
import type { Change, ExperimentDef, GoalRule, TargetRule, VariantDef } from './types.ts';

export type Created = { ok: true; def: ExperimentDef } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown, min = 0, max = 500): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const strings = (x: unknown, max = 100): x is string[] => Array.isArray(x) && x.length <= max && x.every((s) => isStr(s, 1, 300));

const KINDS = ['text', 'order', 'style'];
const STYLE_KEYS = ['color', 'background', 'fontFamily', 'fontSizePx'];
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** Bounds for settings an owner may change. Anything else on Config is fixed. */
const BOUNDS: Record<string, [number, number]> = {
  windowDays: [1, 30],
  floor: [0, 0.2],
  draws: [500, 20000],
  canaryShare: [0.001, 0.5],
  canaryMinExposures: [50, 100000],
  canaryMinDays: [0, 30],
  warmupMinExposures: [50, 1000000],
  warmupMinDays: [0, 60],
  slowPickMinMatured: [50, 1000000],
  banditMinDays: [1, 60],
  banditMaxDays: [1, 120],
  banditStopProb: [0.5, 0.9999],
  retireProb: [0, 0.5],
  slowGoalShare: [0, 1],
  lagThresholdDays: [0, 30],
  'confirm.relMde': [0.01, 2],
  'confirm.alpha': [0.001, 0.2],
  'confirm.power': [0.5, 0.99],
  'confirm.fallbackBaseline': [0.0005, 0.9],
  'confirm.minPerArm': [0, 10000000],
  'confirm.maxDays': [1, 365],
};

function configOverrides(input: unknown, errors: string[]): DeepPartial<Config> {
  if (input === undefined) return {};
  if (!isObj(input)) {
    errors.push('config must be an object');
    return {};
  }
  const base = makeConfig('x') as unknown as Obj;
  const walk = (given: Obj, defaults: Obj, prefix: string): Obj => {
    const out: Obj = {};
    for (const [k, v] of Object.entries(given)) {
      const path = prefix + k;
      if (!(k in defaults) || path === 'id') {
        errors.push(`config.${path} is not a setting`);
        continue;
      }
      const d = defaults[k];
      if (isObj(d)) {
        if (!isObj(v)) errors.push(`config.${path} must be an object`);
        else out[k] = walk(v, d, `${path}.`);
      } else if (typeof d === 'boolean') {
        if (typeof v !== 'boolean') errors.push(`config.${path} must be true or false`);
        else out[k] = v;
      } else if (!isNum(v)) {
        errors.push(`config.${path} must be a number`);
      } else {
        const b = BOUNDS[path];
        if (!b) errors.push(`config.${path} cannot be changed`);
        else if (v < b[0] || v > b[1]) errors.push(`config.${path} must be between ${b[0]} and ${b[1]}`);
        else out[k] = v;
      }
    }
    return out;
  };
  return walk(input, base, '') as DeepPartial<Config>;
}

function parsePolicy(x: unknown, errors: string[]): Policy | null {
  const before = errors.length;
  if (!isObj(x)) {
    errors.push('policy is required');
    return null;
  }
  const { slots, neverChange, facts, brand } = x;
  if (!isObj(slots) || Object.keys(slots).length === 0) errors.push('policy.slots must list the places that may change');
  else {
    for (const [sel, s] of Object.entries(slots)) {
      if (!isObj(s) || !Array.isArray(s.kinds) || s.kinds.length === 0 || !s.kinds.every((k) => KINDS.includes(k as string))) errors.push(`policy.slots["${sel}"].kinds must be some of text, order, style`);
      else if (s.maxChars !== undefined && !isNum(s.maxChars)) errors.push(`policy.slots["${sel}"].maxChars must be a number`);
    }
  }
  if (!strings(neverChange)) errors.push('policy.neverChange must be a list of words');
  if (!isObj(facts) || !strings(facts.numbers) || !strings(facts.claims)) errors.push('policy.facts needs numbers and claims, both lists');
  if (!isObj(brand) || !strings(brand.colors) || !strings(brand.fonts) || !strings(brand.forbiddenWords) || !isNum(brand.minFontPx) || !isNum(brand.maxFontPx)) {
    errors.push('policy.brand needs colors, fonts, forbiddenWords, minFontPx and maxFontPx');
  }
  return errors.length === before ? (x as unknown as Policy) : null;
}

function parseChange(x: unknown, where: string, errors: string[]): Change | null {
  const before = errors.length;
  if (!isObj(x)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  if (!isStr(x.selector, 1, 200) || /[<>{}]/.test(x.selector)) errors.push(`${where}.selector is missing or not a plain selector`);
  if (!KINDS.includes(x.kind as string)) errors.push(`${where}.kind must be text, order or style`);
  const ctx = x.context;
  if (!isObj(ctx) || !isStr(ctx.color, 1, 40) || !isStr(ctx.background, 1, 40) || !isNum(ctx.fontSizePx)) errors.push(`${where}.context needs color, background and fontSizePx (how the element looks today)`);
  if (x.kind === 'text' && !isStr(x.text, 1, 500)) errors.push(`${where}.text is missing`);
  if (x.kind === 'style') {
    if (!isObj(x.style) || Object.keys(x.style).length === 0) errors.push(`${where}.style is missing`);
    else {
      for (const [k, v] of Object.entries(x.style)) {
        if (!STYLE_KEYS.includes(k)) errors.push(`${where}.style.${k} is not allowed`);
        else if (k === 'fontSizePx' ? !isNum(v) : !isStr(v, 1, 80)) errors.push(`${where}.style.${k} has the wrong type`);
      }
    }
  }
  if (x.kind === 'order' && (!strings(x.order, 50) || !strings(x.originalOrder, 50))) errors.push(`${where} needs order and originalOrder, both lists of item keys`);
  return errors.length === before ? (x as unknown as Change) : null;
}

/**
 * Turns what an owner sends into an experiment definition, or says what is wrong.
 * Every change in every variant goes through the safety checks here, before any visitor can see it.
 */
export function validateNewExperiment(input: unknown): Created {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['body must be a JSON object'] };

  const name = input.name;
  if (!isStr(name, 1, 80)) errors.push('name is required (up to 80 characters)');

  let id = '';
  if (input.id === undefined) id = newKey('exp');
  else if (typeof input.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(input.id)) id = input.id;
  else errors.push('id must be 3 to 64 letters, digits, - or _');

  let target: TargetRule | null = null;
  if (isObj(input.target) && cleanPath(input.target.path as string) !== null && (input.target.match === undefined || input.target.match === 'exact' || input.target.match === 'prefix')) {
    target = { path: cleanPath(input.target.path as string) as string, match: (input.target.match as 'exact' | 'prefix' | undefined) ?? 'exact' };
  } else errors.push('target needs a path that starts with /');

  let goal: GoalRule | null = null;
  if (isObj(input.goal) && input.goal.type === 'click' && isStr(input.goal.selector, 1, 200) && !/[<>{}]/.test(input.goal.selector)) {
    goal = { type: 'click', selector: input.goal.selector };
  } else if (isObj(input.goal) && input.goal.type === 'pageview' && cleanPath(input.goal.path as string) !== null) {
    goal = { type: 'pageview', path: cleanPath(input.goal.path as string) as string };
  } else errors.push('goal must be {type:"click", selector} or {type:"pageview", path}');

  const origins = input.allowedOrigins;
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 10 || !origins.every((o) => typeof o === 'string' && ORIGIN_RE.test(o))) {
    errors.push('allowedOrigins must list 1 to 10 sites like https://example.com (no path)');
  }

  const policy = parsePolicy(input.policy, errors);
  const overrides = configOverrides(input.config, errors);

  const variants: Record<string, VariantDef> = {};
  const order: string[] = [];
  if (!isObj(input.variants) || Object.keys(input.variants).length === 0 || Object.keys(input.variants).length > 6) {
    errors.push('variants must have 1 to 6 entries');
  } else {
    for (const [vid, raw] of Object.entries(input.variants)) {
      if (!VARIANT_RE.test(vid) || vid === CONTROL_ID) {
        errors.push(`variant id "${vid}" must be lower case letters, digits, - or _, and not "${CONTROL_ID}"`);
        continue;
      }
      if (!isObj(raw) || !isStr(raw.label, 1, 80) || !Array.isArray(raw.changes) || raw.changes.length === 0 || raw.changes.length > 8) {
        errors.push(`variants.${vid} needs a label and 1 to 8 changes`);
        continue;
      }
      const changes: Change[] = [];
      raw.changes.forEach((c, i) => {
        const parsed = parseChange(c, `variants.${vid}.changes[${i}]`, errors);
        if (parsed) changes.push(parsed);
      });
      const selectors = changes.map((c) => `${c.selector}|${c.kind}`);
      if (new Set(selectors).size !== selectors.length) errors.push(`variants.${vid} changes the same place twice`);
      variants[vid] = { label: raw.label, changes };
      order.push(vid);
    }
  }

  // Safety checks run last, and only on things that are well-formed.
  if (errors.length === 0 && policy) {
    for (const vid of order) {
      for (const c of variants[vid].changes) {
        const r = checkVariant(c, policy);
        for (const f of r.failures) errors.push(`variants.${vid} (${c.selector}): ${f.check}: ${f.reason}`);
      }
    }
  }

  if (errors.length > 0 || !policy || !target || !goal || !isStr(name, 1, 80)) return { ok: false, errors };
  const config = makeConfig(id, overrides);
  return {
    ok: true,
    def: { id, name, order, variants, target, goal, allowedOrigins: origins as string[], policy, config },
  };
}
