#!/usr/bin/env node

/**
 * Builds component-registry.json from Figma REST API.
 * Usage: FIGMA_TOKEN=figd_xxx node registry/build-registry.js
 */

const LIBRARIES = {
  'fat-marker': { fileKey: 'X2JSEUyLvxyNCx22ucOexn', name: 'Fat Marker Kit' },
  'ds2026': { fileKey: 'l8biHxfarNi1I2RMvVxVOK', name: 'Actian Design System 2026' }
};

const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.error('Error: FIGMA_TOKEN environment variable is required');
  process.exit(1);
}

async function fetchFigma(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { 'X-Figma-Token': TOKEN }
  });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getComponents(fileKey) {
  const data = await fetchFigma(`/files/${fileKey}/components`);
  return data.meta.components || [];
}

async function getComponentSets(fileKey) {
  const data = await fetchFigma(`/files/${fileKey}/component_sets`);
  return data.meta.component_sets || [];
}

/**
 * Fetch node details in batches to get componentPropertyDefinitions.
 * The /files/:key/nodes endpoint accepts comma-separated node IDs.
 */
async function getNodeDetails(fileKey, nodeIds) {
  const BATCH_SIZE = 50;
  const results = {};
  for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + BATCH_SIZE);
    const ids = batch.join(',');
    const data = await fetchFigma(`/files/${fileKey}/nodes?ids=${encodeURIComponent(ids)}`);
    for (const [id, node] of Object.entries(data.nodes)) {
      results[id] = node.document;
    }
  }
  return results;
}

function extractFromNode(node) {
  const variants = {};
  const variantShortNames = {};
  const textProperties = [];
  const booleanProperties = [];
  const instanceSwapProperties = [];

  const defs = node.componentPropertyDefinitions;
  if (defs) {
    for (const [fullName, def] of Object.entries(defs)) {
      if (def.type === 'VARIANT') {
        const shortName = fullName.split('#')[0];
        variants[fullName] = def.variantOptions || [];
        variantShortNames[shortName] = fullName;
      } else if (def.type === 'TEXT') {
        textProperties.push(fullName);
      } else if (def.type === 'BOOLEAN') {
        booleanProperties.push(fullName);
      } else if (def.type === 'INSTANCE_SWAP') {
        instanceSwapProperties.push(fullName);
      }
    }
  }

  return { variants, variantShortNames, textProperties, booleanProperties, instanceSwapProperties };
}

async function buildRegistry() {
  const registry = {
    meta: {
      generatedAt: new Date().toISOString(),
      libraries: LIBRARIES
    },
    components: {}
  };

  for (const [libId, lib] of Object.entries(LIBRARIES)) {
    console.log(`Fetching components from ${lib.name}...`);
    const [components, componentSets] = await Promise.all([
      getComponents(lib.fileKey),
      getComponentSets(lib.fileKey)
    ]);

    console.log(`  Found ${components.length} components, ${componentSets.length} component sets`);

    // Fetch node details for component sets to get property definitions
    if (componentSets.length > 0) {
      const nodeIds = componentSets.map(cs => cs.node_id);
      console.log(`  Fetching node details for ${nodeIds.length} component sets...`);
      const nodeDetails = await getNodeDetails(lib.fileKey, nodeIds);

      for (const cs of componentSets) {
        const node = nodeDetails[cs.node_id];
        const props = node ? extractFromNode(node) : {
          variants: {}, variantShortNames: {}, textProperties: [],
          booleanProperties: [], instanceSwapProperties: []
        };

        registry.components[cs.name] = {
          key: cs.key,
          nodeId: cs.node_id,
          library: libId,
          ...props
        };
      }
    }

    // Standalone components (no variants) from the components endpoint
    for (const comp of components) {
      if (!registry.components[comp.name]) {
        registry.components[comp.name] = {
          key: comp.key,
          nodeId: comp.node_id,
          library: libId,
          variants: {},
          variantShortNames: {},
          textProperties: [],
          booleanProperties: [],
          instanceSwapProperties: []
        };
      }
    }
  }

  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'component-registry.json');
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
  console.log(`\nRegistry written to ${outPath}`);
  console.log(`Total components: ${Object.keys(registry.components).length}`);
}

buildRegistry().catch(err => {
  console.error('Failed to build registry:', err.message);
  process.exit(1);
});
