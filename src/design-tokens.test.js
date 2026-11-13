import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Guard the palette relationships, including interaction states, rather than exact hex values.
const css = readFileSync(resolvePath('css/tokens.css'), 'utf8');
const declarations = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
const dark = declarations(css.match(/:root\s*\{([^}]+)\}/)[1]);
const light = { ...dark, ...declarations(css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)[1]) };
const resolve = (tokens, key) => tokens[key].startsWith('var(') ? resolve(tokens, tokens[key].slice(4, -1)) : tokens[key];
function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
}
function contrast(tokens, foreground, background) {
  const a = luminance(resolve(tokens, foreground)), b = luminance(resolve(tokens, background));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
it.each([['dark', dark], ['light', light]])('keeps text and controls readable in the %s theme', (_, tokens) => {
  for (const fill of ['--action-primary', '--action-primary-hover', '--action-primary-pressed']) {
    expect(contrast(tokens, '--on-action', fill), `button text on ${fill}`).toBeGreaterThanOrEqual(4.5);
  }
  for (const surface of ['--canvas', '--surface', '--surface-subtle', '--surface-raised']) {
    for (const text of ['--text-primary', '--text-secondary', '--text-brand', '--text-success', '--text-warning', '--text-danger']) {
      expect(contrast(tokens, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens, '--border-control', surface), `control boundary on ${surface}`).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens, '--focus-ring', surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});
