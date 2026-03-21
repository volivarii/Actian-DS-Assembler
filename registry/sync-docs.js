#!/usr/bin/env node

/**
 * Syncs DS2026 component reference docs from Figma REST API.
 * Run whenever the design system changes.
 *
 * Usage: FIGMA_TOKEN=figd_xxx node registry/sync-docs.js
 *
 * Outputs:
 *   - docs/ds2026-component-reference.md (in Claude plugin repo)
 *   - registry/component-registry.json (updated)
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.error('Error: FIGMA_TOKEN environment variable is required');
  process.exit(1);
}

const DS2026_FILE_KEY = 'l8biHxfarNi1I2RMvVxVOK';
const CLAUDE_PLUGIN_DIR = path.resolve(__dirname, '../../actian-design-system-plugin');

async function fetchFigma(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { 'X-Figma-Token': TOKEN }
  });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function syncDocs() {
  console.log('Fetching DS2026 file info...');
  const fileInfo = await fetchFigma(`/files/${DS2026_FILE_KEY}?depth=1`);
  console.log(`File: ${fileInfo.name}`);
  console.log(`Last modified: ${fileInfo.lastModified}`);

  console.log('\nFetching component sets...');
  const setsData = await fetchFigma(`/files/${DS2026_FILE_KEY}/component_sets`);
  const sets = setsData.meta.component_sets || [];
  console.log(`  ${sets.length} component sets`);

  console.log('Fetching individual components...');
  const compsData = await fetchFigma(`/files/${DS2026_FILE_KEY}/components`);
  const comps = compsData.meta.components || [];
  console.log(`  ${comps.length} individual components`);

  // Generate markdown reference
  const md = [];
  md.push('# Actian Design System 2026 — Component Reference');
  md.push('');
  md.push(`Auto-generated from Figma REST API on ${new Date().toISOString().split('T')[0]}.`);
  md.push(`${sets.length} component sets, ${comps.length} individual components.`);
  md.push('');
  md.push(`Source: [Actian Design System 2026](https://www.figma.com/design/${DS2026_FILE_KEY})`);
  md.push('');
  md.push('---');
  md.push('');

  // Group by page
  const byPage = {};
  for (const cs of sets) {
    const page = (cs.containing_frame || {}).pageName || 'Unknown';
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(cs);
  }

  // Pages
  const pages = fileInfo.document.children.map(p => p.name);
  md.push('## File Structure');
  md.push('');
  md.push('| Page | Components |');
  md.push('|------|-----------|');
  for (const pageName of pages) {
    const count = (byPage[pageName] || []).length;
    if (count > 0) {
      md.push(`| ${pageName} | ${count} component sets |`);
    }
  }
  md.push('');
  md.push('---');
  md.push('');

  // Component details by page
  for (const pageName of pages) {
    const pageComps = byPage[pageName];
    if (!pageComps || pageComps.length === 0) continue;
    if (pageName.startsWith('---') || pageName.startsWith('-----')) continue;

    md.push(`## ${pageName.trim()}`);
    md.push('');

    for (const cs of pageComps.sort((a, b) => a.name.localeCompare(b.name))) {
      md.push(`### ${cs.name}`);
      if (cs.description) {
        md.push('');
        md.push(cs.description);
      }
      md.push('');
      md.push(`- Figma node: \`${cs.node_id}\``);
      md.push(`- Component key: \`${cs.key}\``);
      md.push('');
    }
  }

  // Write to Claude plugin docs
  const docsDir = path.join(CLAUDE_PLUGIN_DIR, 'docs');
  if (fs.existsSync(docsDir)) {
    const outPath = path.join(docsDir, 'ds2026-component-reference.md');
    fs.writeFileSync(outPath, md.join('\n'));
    console.log(`\nComponent reference written to ${outPath}`);
  } else {
    const outPath = path.join(__dirname, 'ds2026-component-reference.md');
    fs.writeFileSync(outPath, md.join('\n'));
    console.log(`\nComponent reference written to ${outPath}`);
    console.log('  (Claude plugin dir not found — saved locally)');
  }

  console.log('\nDone! Run this script again whenever the DS changes.');
}

syncDocs().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
