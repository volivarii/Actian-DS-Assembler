#!/usr/bin/env node

/**
 * Extracts --zen-* token values from tokens.css (Actian theme only).
 * Usage: node registry/build-token-map.js
 */

const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'tokens', 'tokens.css');
const css = fs.readFileSync(cssPath, 'utf8');

// Extract only the :root / [data-theme='actian'] block (first block in file)
const rootBlock = css.match(/:root,\s*\[data-theme='actian'\]\s*\{([^}]+)\}/s);
if (!rootBlock) {
  console.error('Could not find Actian theme block in tokens.css');
  process.exit(1);
}

const tokenMap = {};
const lines = rootBlock[1].split('\n');

for (const line of lines) {
  const match = line.match(/\s*(--zen-[^:]+):\s*(.+?)\s*;/);
  if (match) {
    tokenMap[match[1]] = match[2];
  }
}

const count = Object.keys(tokenMap).length;
if (count < 50) {
  console.error(`Warning: only ${count} tokens found — expected 50+. Check CSS parsing.`);
}

const outPath = path.join(__dirname, 'token-map.json');
fs.writeFileSync(outPath, JSON.stringify(tokenMap, null, 2));
console.log(`Token map written to ${outPath}`);
console.log(`Total tokens: ${count}`);
