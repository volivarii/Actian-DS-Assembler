#!/usr/bin/env node

/**
 * Sync all design system data from Figma REST API.
 *
 * Usage:
 *   FIGMA_TOKEN=figd_xxx node registry/sync-all.js           # sync both libraries
 *   FIGMA_TOKEN=figd_xxx node registry/sync-all.js ds2026    # sync DS2026 only
 *   FIGMA_TOKEN=figd_xxx node registry/sync-all.js fm        # sync Fat Marker only
 *
 * Outputs (in Actian-DS-Assembler/):
 *   registry/component-registry.json   — component keys + variants (used by assembler)
 *   registry/token-map.json            — token name → hex (used by assembler)
 *
 * Outputs (in actian-design-system-plugin/docs/):
 *   ds2026-component-reference.md      — DS2026 component catalog with descriptions
 *   fm-component-catalog.md            — Fat Marker component catalog (updated)
 */

const fs = require("fs");
const path = require("path");

// ── Load .env from project root ──────────────────────────────
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

// ── Config ───────────────────────────────────────────────────
const LIBRARIES = {
  ds2026: {
    fileKey: "l8biHxfarNi1I2RMvVxVOK",
    name: "Actian Design System 2026",
    url: "https://www.figma.com/design/l8biHxfarNi1I2RMvVxVOK",
  },
  "fat-marker": {
    fileKey: "X2JSEUyLvxyNCx22ucOexn",
    name: "Fat Marker Kit",
    url: "https://www.figma.com/design/X2JSEUyLvxyNCx22ucOexn",
  },
};

const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.error("Error: FIGMA_TOKEN environment variable is required");
  console.error(
    "Usage: FIGMA_TOKEN=figd_xxx node registry/sync-all.js [ds2026|fm|all]",
  );
  process.exit(1);
}

const REGISTRY_DIR = path.resolve(__dirname);
const CLAUDE_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../actian-design-system-plugin/plugins/actian-design-system",
);
const DOCS_DIR = path.join(CLAUDE_PLUGIN_DIR, "docs");

// ── Figma API ────────────────────────────────────────────────
async function fetchFigma(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { "X-Figma-Token": TOKEN },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ── Step 1: File structure ───────────────────────────────────
async function getFileStructure(fileKey) {
  const data = await fetchFigma(`/files/${fileKey}?depth=1`);
  return {
    name: data.name,
    lastModified: data.lastModified,
    pages: data.document.children.map((p) => ({ id: p.id, name: p.name })),
  };
}

// ── Step 2: Component sets + components ──────────────────────
async function getComponents(fileKey) {
  const [setsData, compsData] = await Promise.all([
    fetchFigma(`/files/${fileKey}/component_sets`),
    fetchFigma(`/files/${fileKey}/components`),
  ]);
  return {
    componentSets: setsData.meta?.component_sets || [],
    components: compsData.meta?.components || [],
  };
}

// ── Step 3: Styles ───────────────────────────────────────────
async function getStyles(fileKey) {
  const data = await fetchFigma(`/files/${fileKey}/styles`);
  return data.meta?.styles || [];
}

// ── Step 4: Component set detail (variant properties) ────────
async function getComponentSetDetails(fileKey, nodeIds) {
  if (nodeIds.length === 0) return {};
  // Batch in groups of 50
  const results = {};
  for (let i = 0; i < nodeIds.length; i += 50) {
    const batch = nodeIds.slice(i, i + 50);
    const ids = batch.join(",");
    const data = await fetchFigma(`/files/${fileKey}/nodes?ids=${ids}`);
    for (const [nodeId, nodeData] of Object.entries(data.nodes || {})) {
      if (nodeData.document) {
        results[nodeId] = nodeData.document;
      }
    }
    if (i + 50 < nodeIds.length) {
      console.log(
        `    Fetched ${Math.min(i + 50, nodeIds.length)}/${nodeIds.length} node details...`,
      );
    }
  }
  return results;
}

// ── Build registry ───────────────────────────────────────────
function extractFromNode(node) {
  const variants = {};
  const variantShortNames = {};
  const textProperties = [];
  const booleanProperties = [];

  const propDefs = node.componentPropertyDefinitions || {};
  for (const [fullName, def] of Object.entries(propDefs)) {
    const shortName = fullName.split("#")[0];
    if (def.type === "VARIANT") {
      variants[shortName] = def.variantOptions || [];
      variantShortNames[shortName] = shortName;
    } else if (def.type === "TEXT") {
      textProperties.push(fullName);
    } else if (def.type === "BOOLEAN") {
      booleanProperties.push(fullName);
    }
  }

  return { variants, variantShortNames, textProperties, booleanProperties };
}

// ── Build token map from tokens.css ──────────────────────────
function buildTokenMap() {
  const cssPath = path.join(REGISTRY_DIR, "..", "tokens", "tokens.css");
  if (!fs.existsSync(cssPath)) {
    console.log("  tokens/tokens.css not found — skipping token map");
    return {};
  }

  const css = fs.readFileSync(cssPath, "utf8");
  const rootBlock = css.match(
    /:root,\s*\[data-theme='actian'\]\s*\{([^}]+)\}/s,
  );
  if (!rootBlock) {
    console.log("  Could not find Actian theme block — skipping token map");
    return {};
  }

  const tokenMap = {};
  for (const line of rootBlock[1].split("\n")) {
    const match = line.match(/\s*(--zen-[^:]+):\s*(.+?)\s*;/);
    if (match) tokenMap[match[1]] = match[2];
  }

  return tokenMap;
}

// ── Load FM descriptions (manual, since Figma API returns none) ──
function loadFmDescriptions() {
  const descPath = path.join(REGISTRY_DIR, "fm-descriptions.json");
  if (fs.existsSync(descPath)) {
    const raw = JSON.parse(fs.readFileSync(descPath, "utf8"));
    delete raw._comment;
    return raw;
  }
  return {};
}

// ── Generate component reference markdown ────────────────────
function generateComponentReference(
  fileInfo,
  componentSets,
  components,
  libId,
  registryComponents,
) {
  const md = [];
  const isDS = libId === "ds2026";
  const title = isDS ? "Actian Design System 2026" : "Fat Marker Kit";
  const filename = isDS
    ? "ds2026-component-reference.md"
    : "fm-component-catalog.md";
  const fmDescs = isDS ? {} : loadFmDescriptions();

  md.push(`# ${title} — Component Reference`);
  md.push("");
  md.push(
    `Auto-generated from Figma REST API on ${new Date().toISOString().split("T")[0]}.`,
  );
  md.push(
    `${componentSets.length} component sets, ${components.length} individual components.`,
  );
  md.push("");
  md.push(`Source: [${fileInfo.name}](${LIBRARIES[libId].url})`);
  md.push(`Last modified: ${fileInfo.lastModified}`);
  md.push("");
  md.push("---");
  md.push("");

  // Group by page
  const byPage = {};
  for (const cs of componentSets) {
    const page = (cs.containing_frame || {}).pageName || "Unknown";
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(cs);
  }

  // File structure
  md.push("## Pages");
  md.push("");
  for (const page of fileInfo.pages) {
    const count = (byPage[page.name] || []).length;
    const marker = count > 0 ? ` — ${count} component sets` : "";
    md.push(`- ${page.name}${marker}`);
  }
  md.push("");
  md.push("---");
  md.push("");

  // Components by page
  for (const page of fileInfo.pages) {
    const pageComps = byPage[page.name];
    if (!pageComps || pageComps.length === 0) continue;
    if (page.name.startsWith("---") || page.name.startsWith("-----")) continue;

    md.push(`## ${page.name.trim()}`);
    md.push("");

    for (const cs of pageComps.sort((a, b) => a.name.localeCompare(b.name))) {
      md.push(`### ${cs.name}`);

      // Description: from API, or from fm-descriptions.json fallback
      const desc = cs.description || fmDescs[cs.name] || "";
      if (desc) {
        md.push(desc);
      }
      md.push("");

      // Variants from registry
      const reg = registryComponents[cs.name];
      if (reg && Object.keys(reg.variants).length > 0) {
        const varParts = [];
        for (const [axis, values] of Object.entries(reg.variants)) {
          varParts.push(
            `**${axis}:** ${values.map((v) => "`" + v + "`").join(" · ")}`,
          );
        }
        md.push("- Variants: " + varParts.join(" | "));
      }

      // Text properties
      if (reg && reg.textProperties.length > 0) {
        const textNames = reg.textProperties.map(
          (t) => "`" + t.split("#")[0] + "`",
        );
        md.push("- Text overrides: " + textNames.join(", "));
      }

      md.push(`- Node: \`${cs.node_id}\` | Key: \`${cs.key}\``);
      md.push("");
    }
  }

  // Standalone components (not in sets)
  const setNodeIds = new Set(componentSets.map((cs) => cs.node_id));
  const standalone = components.filter((c) => {
    // A component is standalone if its containing_frame is not a component set
    return !c.component_set_id;
  });

  if (standalone.length > 0) {
    // Group standalone by page
    const standByPage = {};
    for (const c of standalone) {
      const page = (c.containing_frame || {}).pageName || "Unknown";
      if (!standByPage[page]) standByPage[page] = [];
      standByPage[page].push(c);
    }

    const hasContent = Object.values(standByPage).some((arr) => arr.length > 0);
    if (hasContent) {
      md.push("## Standalone Components");
      md.push("");
      for (const [page, comps] of Object.entries(standByPage).sort()) {
        if (page.startsWith("---")) continue;
        md.push(`### ${page}`);
        md.push("");
        for (const c of comps.sort((a, b) => a.name.localeCompare(b.name))) {
          md.push(`- **${c.name}** — Key: \`${c.key}\``);
          if (c.description) md.push(`  ${c.description.substring(0, 120)}`);
        }
        md.push("");
      }
    }
  }

  return { content: md.join("\n"), filename };
}

// ── Main ─────────────────────────────────────────────────────
async function syncLibrary(libId) {
  const lib = LIBRARIES[libId];
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Syncing: ${lib.name} (${lib.fileKey})`);
  console.log("=".repeat(60));

  // File structure
  console.log("\n1. Fetching file structure...");
  const fileInfo = await getFileStructure(lib.fileKey);
  console.log(
    `   ${fileInfo.pages.length} pages, last modified ${fileInfo.lastModified}`,
  );

  // Components
  console.log("\n2. Fetching components...");
  const { componentSets, components } = await getComponents(lib.fileKey);
  console.log(
    `   ${componentSets.length} component sets, ${components.length} components`,
  );

  // Styles
  console.log("\n3. Fetching styles...");
  const styles = await getStyles(lib.fileKey);
  const styleTypes = {};
  for (const s of styles) {
    styleTypes[s.style_type] = (styleTypes[s.style_type] || 0) + 1;
  }
  console.log(`   ${styles.length} styles: ${JSON.stringify(styleTypes)}`);

  // Component set details (for variant properties)
  console.log("\n4. Fetching component set details (variants)...");
  const nodeIds = componentSets.map((cs) => cs.node_id);
  const nodeDetails = await getComponentSetDetails(lib.fileKey, nodeIds);
  console.log(`   ${Object.keys(nodeDetails).length} node details fetched`);

  // Build registry entries
  console.log("\n5. Building registry...");
  const registryComponents = {};

  // Component sets (with variants)
  for (const cs of componentSets) {
    const detail = nodeDetails[cs.node_id];
    const { variants, variantShortNames, textProperties, booleanProperties } =
      detail
        ? extractFromNode(detail)
        : {
            variants: {},
            variantShortNames: {},
            textProperties: [],
            booleanProperties: [],
          };

    registryComponents[cs.name] = {
      key: cs.key,
      library: libId,
      description: cs.description || "",
      page: (cs.containing_frame || {}).pageName || "",
      variants,
      variantShortNames,
      textProperties,
      booleanProperties,
    };
  }

  // Standalone components (no variants)
  for (const comp of components) {
    if (!registryComponents[comp.name]) {
      registryComponents[comp.name] = {
        key: comp.key,
        library: libId,
        description: comp.description || "",
        page: (comp.containing_frame || {}).pageName || "",
        variants: {},
        variantShortNames: {},
        textProperties: [],
        booleanProperties: [],
      };
    }
  }

  console.log(
    `   ${Object.keys(registryComponents).length} total components in registry`,
  );

  // Generate reference doc
  console.log("\n6. Generating reference doc...");
  const { content, filename } = generateComponentReference(
    fileInfo,
    componentSets,
    components,
    libId,
    registryComponents,
  );

  if (fs.existsSync(DOCS_DIR)) {
    const outPath = path.join(DOCS_DIR, filename);
    fs.writeFileSync(outPath, content);
    console.log(`   Written to ${outPath}`);
  } else {
    const outPath = path.join(REGISTRY_DIR, filename);
    fs.writeFileSync(outPath, content);
    console.log(`   Written to ${outPath} (Claude plugin dir not found)`);
  }

  return {
    libId,
    fileInfo,
    components: registryComponents,
    styles,
  };
}

async function main() {
  const arg = process.argv[2] || "all";
  const targets =
    arg === "all"
      ? ["ds2026", "fat-marker"]
      : arg === "ds2026"
        ? ["ds2026"]
        : arg === "fm"
          ? ["fat-marker"]
          : [arg];

  console.log(`DS Assembler — Sync All`);
  console.log(`Targets: ${targets.join(", ")}`);

  // Sync each library
  const allComponents = {};
  for (const libId of targets) {
    if (!LIBRARIES[libId]) {
      console.error(`Unknown library: ${libId}. Use: ds2026, fm, or all`);
      process.exit(1);
    }
    const result = await syncLibrary(libId);
    Object.assign(allComponents, result.components);
  }

  // Build combined registry
  console.log(`\n${"=".repeat(60)}`);
  console.log("Building combined registry...");
  const registry = {
    meta: {
      generatedAt: new Date().toISOString(),
      libraries: {},
    },
    components: allComponents,
  };
  for (const libId of targets) {
    registry.meta.libraries[libId] = LIBRARIES[libId];
  }

  const registryPath = path.join(REGISTRY_DIR, "component-registry.json");
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  console.log(
    `Registry: ${Object.keys(allComponents).length} components → ${registryPath}`,
  );

  // Build token map
  console.log("\nBuilding token map...");
  const tokenMap = buildTokenMap();
  const tokenCount = Object.keys(tokenMap).length;
  if (tokenCount > 0) {
    const tokenPath = path.join(REGISTRY_DIR, "token-map.json");
    fs.writeFileSync(tokenPath, JSON.stringify(tokenMap, null, 2));
    console.log(`Token map: ${tokenCount} tokens → ${tokenPath}`);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Sync complete!");
  console.log("");
  console.log("Updated files:");
  console.log(
    `  registry/component-registry.json  (${Object.keys(allComponents).length} components)`,
  );
  if (tokenCount > 0)
    console.log(`  registry/token-map.json           (${tokenCount} tokens)`);
  for (const libId of targets) {
    const filename =
      libId === "ds2026"
        ? "ds2026-component-reference.md"
        : "fm-component-catalog.md";
    console.log(`  docs/${filename}`);
  }
  console.log("");
  console.log("Next: rebuild the plugin if registry changed:");
  console.log("  cd plugin && npm run build");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
