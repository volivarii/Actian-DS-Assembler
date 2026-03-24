// DS Assembler — Analyzer: walks Figma document tree, detects instances and issues

import {
  Registry,
  AnalysisResult,
  InstanceInfo,
  Issue,
  AnalysisStats,
} from "./types";

let registry: Registry | null = null;
let abortAnalysis = false;

/** Called when registry is loaded so analyzer can do reverse lookups. */
export function setAnalyzerRegistry(reg: Registry) {
  registry = reg;
}

/** Signal the analyzer to stop early. */
export function cancelAnalysis() {
  abortAnalysis = true;
}

// ── Helpers ──────────────────────────────────────────────────

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build reverse map: componentKey -> componentName from registry. */
function buildKeyToName(): Map<string, string> {
  const map = new Map<string, string>();
  if (!registry) return map;
  for (const [name, entry] of Object.entries(registry.components)) {
    map.set(entry.key, name);
  }
  return map;
}

/** Count total traversable nodes in a subtree (skips instance internals). */
function countTraversable(node: BaseNode): number {
  let count = 1;
  if (node.type === "INSTANCE") return count; // don't recurse into instances
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children) {
      count += countTraversable(child);
    }
  }
  return count;
}

/** Check if a solid fill is hardcoded (not bound to a variable). */
function isHardcodedFill(node: SceneNode): {
  hardcoded: boolean;
  hex?: string;
} {
  if (!("fills" in node)) return { hardcoded: false };
  const fills = (node as GeometryMixin).fills;
  if (!Array.isArray(fills) || fills.length === 0) return { hardcoded: false };

  const first = fills[0];
  if (first.type !== "SOLID" || !first.visible) return { hardcoded: false };

  // Check if bound to a variable
  const bound = (node as any).boundVariables;
  if (bound && bound.fills) return { hardcoded: false };

  const { r, g, b } = first.color;
  const hex =
    "#" +
    [r, g, b]
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  // Skip white and black — commonly used without tokens
  if (hex === "#ffffff" || hex === "#000000") return { hardcoded: false };

  return { hardcoded: true, hex };
}

/** Extract variant properties from an instance. */
function extractVariants(inst: InstanceNode): Record<string, string> {
  const variants: Record<string, string> = {};
  try {
    const props = inst.componentProperties;
    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "VARIANT") {
        // Strip the trailing hash ID from property names (e.g. "Size#1234" -> "Size")
        const cleanKey = key.split("#")[0];
        variants[cleanKey] = String(prop.value);
      }
    }
  } catch (_) {
    // componentProperties may not be available on all instances
  }
  return variants;
}

/** Extract text overrides from an instance. */
function extractTextOverrides(inst: InstanceNode): Record<string, string> {
  const overrides: Record<string, string> = {};
  try {
    const props = inst.componentProperties;
    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "TEXT") {
        const cleanKey = key.split("#")[0];
        overrides[cleanKey] = String(prop.value);
      }
    }
  } catch (_) {
    // ignore
  }
  return overrides;
}

// ── Main analysis function ───────────────────────────────────

export async function analyzeScope(
  scope: "selection" | "page" | "file",
): Promise<AnalysisResult> {
  abortAnalysis = false;

  const keyToName = buildKeyToName();
  const instances: InstanceInfo[] = [];
  const issues: Issue[] = [];
  const uniqueComponents = new Set<string>();

  let totalNodes = 0;
  let hardcodedColors = 0;
  let missingAutoLayout = 0;

  // Determine roots to scan
  let roots: readonly SceneNode[] | PageNode[];
  if (scope === "selection") {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      throw new Error(
        "Nothing selected. Please select one or more layers and try again.",
      );
    }
    roots = sel;
  } else if (scope === "page") {
    roots = [figma.currentPage];
  } else {
    roots = figma.root.children.slice(); // all pages
  }

  // Count total traversable nodes for progress
  let totalTraversable = 0;
  for (const root of roots) {
    totalTraversable += countTraversable(root);
  }

  let visited = 0;

  // Walk function (non-recursive to avoid stack overflow on large files)
  async function walk(node: BaseNode) {
    if (abortAnalysis) return;

    visited++;
    totalNodes++;

    if (visited % 50 === 0) {
      figma.ui.postMessage({
        type: "analysis-progress",
        current: visited,
        total: totalTraversable,
      });
      await yieldToMain();
    }

    const scene = node as SceneNode;

    // ── Instance detection ──
    if (node.type === "INSTANCE") {
      const inst = node as InstanceNode;
      const mainComp = inst.mainComponent;
      const compKey = mainComp?.key || "";
      const compName = keyToName.get(compKey) || mainComp?.name || "Unknown";
      const library = mainComp?.remote ? "external" : "local";

      if (compKey) uniqueComponents.add(compKey);

      instances.push({
        nodeId: inst.id,
        name: inst.name,
        componentKey: compKey,
        componentName: compName,
        library,
        variants: extractVariants(inst),
        textOverrides: extractTextOverrides(inst),
        x: inst.x,
        y: inst.y,
        width: inst.width,
        height: inst.height,
      });

      // Don't recurse into instance internals
      return;
    }

    // ── Hardcoded color detection ──
    if ("fills" in scene) {
      const result = isHardcodedFill(scene);
      if (result.hardcoded) {
        hardcodedColors++;
        issues.push({
          nodeId: scene.id,
          type: "hardcoded-color",
          description: `Hardcoded fill ${result.hex} on "${scene.name}"`,
          severity: "warning",
        });
      }
    }

    // ── Missing auto-layout detection ──
    if (
      node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET"
    ) {
      const frame = node as FrameNode;
      if (
        frame.layoutMode === "NONE" &&
        "children" in frame &&
        frame.children.length >= 3
      ) {
        missingAutoLayout++;
        issues.push({
          nodeId: frame.id,
          type: "missing-auto-layout",
          description: `Frame "${frame.name}" has ${frame.children.length} children but no auto-layout`,
          severity: "info",
        });
      }
    }

    // ── Recurse into children ──
    if ("children" in node) {
      for (const child of (node as ChildrenMixin).children) {
        if (abortAnalysis) return;
        await walk(child);
      }
    }
  }

  // Run the walk
  for (const root of roots) {
    if (abortAnalysis) break;
    // For file scope, need to load each page
    if (scope === "file" && root !== figma.currentPage) {
      try {
        await (root as PageNode).loadAsync();
      } catch (_) {
        // page may fail to load — skip it
        continue;
      }
    }
    // For selection scope, walk each selected node directly
    if (scope === "selection") {
      await walk(root);
    } else {
      for (const child of (root as PageNode).children) {
        if (abortAnalysis) break;
        await walk(child);
      }
    }
  }

  const stats: AnalysisStats = {
    totalNodes,
    instances: instances.length,
    uniqueComponents: uniqueComponents.size,
    hardcodedColors,
    missingAutoLayout,
  };

  const currentPage = figma.currentPage;

  return {
    file: { name: figma.root.name, key: "" }, // file key not available in plugin API
    scope,
    page: { name: currentPage.name, id: currentPage.id },
    instances,
    issues,
    stats,
  };
}
