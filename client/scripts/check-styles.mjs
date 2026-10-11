import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import postcss from 'postcss';

const assets = new URL('../dist/assets/', import.meta.url);
const filename = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
assert.ok(filename, 'The production entry stylesheet must exist');
const css = postcss.parse(await readFile(new URL(filename, assets), 'utf8'));
const rules = [];
css.walkRules((rule) => rules.push(rule));
const hasRule = (selector) => rules.some((rule) => rule.selector === selector);
const declarations = (selector, property) => rules
  .filter((rule) => rule.selector === selector)
  .flatMap((rule) => rule.nodes.filter((node) => node.type === 'decl' && node.prop === property))
  .map((node) => node.value);

test('production CSS includes the Robin theme and shared controls', () => {
  const theme = new Map();
  css.walkDecls(/^--(?:color-robin|font-sans|font-mono)/, (node) => theme.set(node.prop, node.value));
  assert.equal(theme.get('--color-robin-orange'), '#fe8502');
  assert.equal(theme.get('--color-robin-green'), '#44a83a');
  assert.equal(theme.get('--color-robin-gray-900'), '#1a1a1a');
  assert.match(theme.get('--font-sans'), /Arial.*Helvetica.*sans-serif/);
  assert.match(theme.get('--font-mono'), /Consolas/);
  for (const selector of ['.btn', '.btn-primary', '.btn-secondary', '.input', '.card', '.table th', '.table td', '.sidebar-link.active']) {
    assert.ok(hasRule(selector), `Missing shared control: ${selector}`);
  }
});

test('dark mode follows the host class and responsive utilities are generated', () => {
  assert.ok(hasRule('.card:is(.dark *)'));
  assert.ok(hasRule('.input:is(.dark *)'));
  assert.ok(hasRule('.sidebar-link.active:is(.dark *)'));
  const queries = [];
  css.walkAtRules('media', (rule) => queries.push(rule.params));
  assert.ok(queries.some((query) => /width.*48rem/.test(query)));
  assert.ok(queries.some((query) => /hover:\s*hover/.test(query)));
});

test('utilities override shared control defaults without changing their dimensions', () => {
  const index = (selector) => rules.findLastIndex((rule) => rule.selector === selector);
  assert.ok(index('.p-4') > index('.card'));
  assert.ok(index('.border-red-500') > index('.input'));
  assert.ok(declarations('.input', 'border-radius').includes('var(--radius-sm)'));
  assert.ok(declarations('.btn', 'border-radius').includes('var(--radius-sm)'));
  assert.ok(declarations('.shrink-0', 'flex-shrink').includes('0'));
  assert.ok(declarations('.wrap-break-word', 'overflow-wrap').includes('break-word'));
  const lineHeights = new Map();
  css.walkDecls(/^--text-(?:xs|sm)--line-height$/, (node) => lineHeights.set(node.prop, node.value));
  assert.equal(lineHeights.get('--text-xs--line-height'), '1rem');
  assert.equal(lineHeights.get('--text-sm--line-height'), '1.25rem');
  assert.ok(hasRule('.input:focus'));
  assert.ok(hasRule('.btn:disabled'));
});

test('the stylesheet contains compiled CSS, not unprocessed Tailwind directives', () => {
  css.walkAtRules((rule) => {
    assert.ok(!['tailwind', 'apply', 'theme', 'utility', 'custom-variant'].includes(rule.name), `Uncompiled @${rule.name}`);
  });
});
