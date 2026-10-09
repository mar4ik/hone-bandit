import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVariant } from '../src/safety/policy.ts';
import type { Policy, Proposal } from '../src/safety/policy.ts';
import { contrastRatio, requiredContrast } from '../src/safety/contrast.ts';

const policy: Policy = {
  slots: {
    'h1.hero-title': { kinds: ['text'], maxChars: 70 },
    'a.hero-cta': { kinds: ['text', 'style'], maxChars: 28 },
    'section#courses': { kinds: ['order'] },
  },
  neverChange: ['price', 'legal', 'consent', 'form', 'checkout', 'cookie'],
  facts: { numbers: [], claims: [] },
  brand: {
    colors: ['#14202B', '#F6F6F1', '#C8381A', '#FFFFFF'],
    fonts: ['Newsreader', 'Hanken Grotesk'],
    minFontPx: 14,
    maxFontPx: 72,
    forbiddenWords: ['guru', 'hack'],
  },
};

const ctx = { color: '#14202B', background: '#F6F6F1', fontSizePx: 48 };
const headline = (text: string, p: Policy = policy) => checkVariant({ selector: 'h1.hero-title', kind: 'text', text, context: ctx }, p);
const checks = (r: ReturnType<typeof checkVariant>) => r.failures.map((f) => f.check);

test('ordinary headlines pass', () => {
  for (const t of [
    'Start building with AI today',
    'Learn AI without the jargon',
    'A practical way into AI, one project at a time',
    'Build your first AI project this month',
  ]) {
    const r = headline(t);
    assert.equal(r.ok, true, `${t}: ${JSON.stringify(r.failures)}`);
  }
});

test('planted bad variant: a discount that is not in the facts is blocked', () => {
  const r = headline('Save 30% this week');
  assert.equal(r.ok, false);
  assert.ok(checks(r).includes('facts'));
  assert.ok(checks(r).includes('honesty'));
});

test('even with the discount approved, an invented deadline is still blocked', () => {
  const r = headline('Save 30% this week', { ...policy, facts: { numbers: ['30%'], claims: [] } });
  assert.equal(r.ok, false);
  assert.deepEqual(checks(r), ['honesty']);
  assert.equal(headline('Save 30% on your first course', { ...policy, facts: { numbers: ['30%'], claims: [] } }).ok, true);
});

test('planted bad variant: a new quantity claim is blocked until the owner approves it', () => {
  assert.deepEqual(checks(headline('Join thousands of learners')), ['facts']);
  assert.equal(headline('Join thousands of learners', { ...policy, facts: { numbers: [], claims: ['thousands of learners'] } }).ok, true);
});

test('numbers must match the approved fact, including the unit', () => {
  const withFact = { ...policy, facts: { numbers: ['4 weeks'], claims: [] } };
  assert.equal(headline('Learn AI in four weeks', withFact).ok, true);
  assert.equal(headline('Learn AI in 4 weeks', withFact).ok, true);
  assert.equal(headline('Learn AI in 6 weeks', withFact).ok, false);
  assert.equal(headline('Learn AI in 4 days', withFact).ok, false);
  assert.equal(headline('Learn AI in four weeks').ok, false);
});

test('claims such as "free" or "best" need approval', () => {
  assert.equal(headline('Start a free lesson').ok, false);
  assert.equal(headline('Start a free lesson', { ...policy, facts: { numbers: [], claims: ['free'] } }).ok, true);
  assert.equal(headline('The best way to learn AI').ok, false);
});

test('false urgency and invented scarcity are blocked', () => {
  for (const t of ['Only 3 spots left', 'Hurry, last chance to join', 'Offer ends tonight', 'Limited time: learn AI']) {
    const r = headline(t);
    assert.equal(r.ok, false, t);
    assert.ok(checks(r).includes('honesty'), `${t}: ${JSON.stringify(r.failures)}`);
  }
});

test('markup and links are blocked, and so are places that were not allowed', () => {
  assert.ok(checks(headline('<b>Buy now</b>')).includes('scope'));
  assert.ok(checks(headline('Learn more at https://other.example')).includes('scope'));
  const r = checkVariant({ selector: 'div.price-box', kind: 'text', text: 'Cheap', context: ctx }, policy);
  assert.equal(r.ok, false);
  assert.ok(checks(r).includes('scope'));
  const wrongKind = checkVariant({ selector: 'h1.hero-title', kind: 'style', style: { color: '#C8381A' }, context: ctx }, policy);
  assert.ok(checks(wrongKind).includes('scope'));
});

test('a locked word in the selector blocks the change even if the place was allowed by mistake', () => {
  const sloppy: Policy = { ...policy, slots: { ...policy.slots, 'form#checkout-price': { kinds: ['text'] } } };
  const r = checkVariant({ selector: 'form#checkout-price', kind: 'text', text: 'Pay later', context: ctx }, sloppy);
  assert.equal(r.ok, false);
  assert.ok(checks(r).includes('scope'));
});

test('planted bad variant: white text on a light button fails readability', () => {
  const r = checkVariant(
    { selector: 'a.hero-cta', kind: 'style', style: { color: '#FFFFFF', background: '#F6F6F1' }, context: { color: '#14202B', background: '#C8381A', fontSizePx: 16, bold: true } },
    policy,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(checks(r), ['readability']);
});

test('off-brand colours, fonts and sizes are blocked', () => {
  const base = { selector: 'a.hero-cta', kind: 'style' as const, context: { color: '#14202B', background: '#C8381A', fontSizePx: 16, bold: true } };
  assert.ok(checks(checkVariant({ ...base, style: { background: '#FFD700' } }, policy)).includes('brand'));
  assert.ok(checks(checkVariant({ ...base, style: { fontFamily: 'Comic Sans MS' } }, policy)).includes('brand'));
  assert.ok(checks(checkVariant({ ...base, style: { fontSizePx: 120 } }, policy)).includes('brand'));
  assert.equal(checkVariant({ ...base, style: { color: '#FFFFFF', background: '#C8381A', fontFamily: 'Newsreader' } }, policy).ok, true);
});

test('brand voice: shouting and forbidden words are blocked; length is checked against the slot', () => {
  assert.ok(checks(headline('LEARN AI RIGHT NOW')).includes('brand'));
  assert.ok(checks(headline('Become an AI guru')).includes('brand'));
  const long = 'A very long headline that keeps going and going well past what fits above the fold on a phone';
  assert.ok(checks(headline(long)).includes('readability'));
});

test('reordering may only rearrange what is already there', () => {
  const ok: Proposal = { selector: 'section#courses', kind: 'order', order: ['starter', 'popular', 'advanced'], originalOrder: ['advanced', 'starter', 'popular'], context: ctx };
  assert.equal(checkVariant(ok, policy).ok, true);
  assert.ok(checks(checkVariant({ ...ok, order: ['starter', 'secret-offer', 'popular'] }, policy)).includes('scope'));
  assert.ok(checks(checkVariant({ ...ok, order: ['starter', 'starter', 'popular'] }, policy)).includes('scope'));
});

test('contrast maths matches known values', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.48) < 0.05);
  assert.equal(requiredContrast(16, false), 4.5);
  assert.equal(requiredContrast(24, false), 3);
  assert.equal(requiredContrast(19, true), 3);
});
