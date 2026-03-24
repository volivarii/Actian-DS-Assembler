// DS Assembler — Generic Figma plugin for assembling component instances from JSON specs
// Registry and token map are loaded at runtime from URLs, not bundled.

import {
  ComponentEntry,
  Registry,
  SpecFrame,
  SpecInstance,
  SpecNode,
  UpdateInstruction,
  ComponentSpec,
} from "./types";
import { setAnalyzerRegistry, cancelAnalysis, analyzeScope } from "./analyzer";
import { setUpdaterRegistry, cancelUpdate, applyUpdates } from "./updater";
import { createComponentFromSpec, setCreatorRegistry } from "./creator";

// ── State ────────────────────────────────────────────────────
let registry: Registry | null = null;
let tokenMap: Record<string, string> = {};
let abortRequested = false;
let nodeCount = 0;
let totalNodes = 0;

// ── Component import cache (key perf optimization) ───────────
const componentCache = new Map<string, ComponentNode>();
const componentSetCache = new Map<string, ComponentSetNode>();

async function cachedImportComponent(key: string): Promise<ComponentNode> {
  let c = componentCache.get(key);
  if (!c) {
    c = await figma.importComponentByKeyAsync(key);
    componentCache.set(key, c);
  }
  return c;
}

async function cachedImportComponentSet(
  key: string,
): Promise<ComponentSetNode> {
  let cs = componentSetCache.get(key);
  if (!cs) {
    cs = await figma.importComponentSetByKeyAsync(key);
    componentSetCache.set(key, cs);
  }
  return cs;
}

// ── Helpers ──────────────────────────────────────────────────
function isInstance(node: SpecNode): node is SpecInstance {
  return "component" in node;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sendLog(text: string, level?: string) {
  figma.ui.postMessage({ type: "log", text, level });
}

function sendProgress(current: number, total: number) {
  figma.ui.postMessage({ type: "progress", current, total });
}

function countNodes(spec: SpecNode): number {
  if (isInstance(spec)) return 1;
  return 1 + spec.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function collectUniqueKeys(
  spec: SpecNode,
): Map<string, { key: string; hasVariants: boolean }> {
  const keys = new Map<string, { key: string; hasVariants: boolean }>();
  if (isInstance(spec)) {
    const entry = lookupComponent(spec.component);
    if (entry && !keys.has(entry.key)) {
      keys.set(entry.key, {
        key: entry.key,
        hasVariants: Object.keys(entry.variants).length > 0,
      });
    }
  } else {
    for (const child of spec.children) {
      for (const [k, v] of collectUniqueKeys(child)) keys.set(k, v);
    }
  }
  return keys;
}

// ── Registry lookups ─────────────────────────────────────────
function lookupComponent(name: string): ComponentEntry | null {
  if (!registry) return null;
  return registry.components[name] || null;
}

function resolveVariantProps(
  entry: ComponentEntry,
  shortProps: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [shortName, value] of Object.entries(shortProps)) {
    const fullName = entry.variantShortNames[shortName];
    if (fullName) resolved[fullName] = value;
  }
  return resolved;
}

function resolveTextProps(
  entry: ComponentEntry,
  shortText: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [shortName, value] of Object.entries(shortText)) {
    const fullName = entry.textProperties.find(
      (tp) => tp.split("#")[0] === shortName,
    );
    if (fullName) resolved[fullName] = value;
  }
  return resolved;
}

function resolveColor(value: string): RGB | null {
  if (value.startsWith("#")) return hexToRgb(value);
  const hex = tokenMap[value];
  if (hex) return hexToRgb(hex);
  return null;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  // Handle rgba() values from token map
  if (hex.startsWith("rgba")) return { r: 0.5, g: 0.5, b: 0.5 };
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255,
  };
}

// ── Sizing ───────────────────────────────────────────────────
const ALIGN_MAP = {
  min: "MIN",
  center: "CENTER",
  max: "MAX",
  "space-between": "SPACE_BETWEEN",
} as const;
const COUNTER_ALIGN_MAP = { min: "MIN", center: "CENTER", max: "MAX" } as const;

function applyWidth(
  node: SceneNode,
  width: number | "hug" | "fill" | undefined,
) {
  if (width === undefined) return;
  const n = node as any;
  if (typeof width === "number") {
    n.resize(width, n.height);
    n.layoutSizingHorizontal = "FIXED";
  } else if (width === "fill") {
    n.layoutSizingHorizontal = "FILL";
  } else if (width === "hug") {
    try {
      n.layoutSizingHorizontal = "HUG";
    } catch (_) {}
  }
}

function applyHeight(
  node: SceneNode,
  height: number | "hug" | "fill" | undefined,
) {
  if (height === undefined) return;
  const n = node as any;
  if (typeof height === "number") {
    n.resize(n.width, height);
    n.layoutSizingVertical = "FIXED";
  } else if (height === "fill") {
    n.layoutSizingVertical = "FILL";
  } else if (height === "hug") {
    try {
      n.layoutSizingVertical = "HUG";
    } catch (_) {}
  }
}

const deferredFills = new Map<
  SceneNode,
  { fillWidth: boolean; fillHeight: boolean }
>();

// ── Assembly ─────────────────────────────────────────────────
async function assembleFrame(spec: SpecFrame): Promise<SceneNode | null> {
  if (abortRequested) return null;

  const frame = figma.createFrame();
  frame.name = spec.name || "Frame";
  frame.layoutMode = spec.layout === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  frame.itemSpacing = spec.spacing || 0;
  frame.layoutSizingHorizontal = "HUG";
  frame.layoutSizingVertical = "HUG";

  if (spec.padding) {
    frame.paddingTop = spec.padding.top || 0;
    frame.paddingRight = spec.padding.right || 0;
    frame.paddingBottom = spec.padding.bottom || 0;
    frame.paddingLeft = spec.padding.left || 0;
  }

  if (spec.fill) {
    const color = resolveColor(spec.fill);
    if (color) frame.fills = [{ type: "SOLID", color }];
  } else {
    frame.fills = [];
  }

  if (spec.align) frame.primaryAxisAlignItems = ALIGN_MAP[spec.align] || "MIN";
  if (spec.counterAlign)
    frame.counterAxisAlignItems = COUNTER_ALIGN_MAP[spec.counterAlign] || "MIN";
  if (spec.cornerRadius) frame.cornerRadius = spec.cornerRadius;

  const childNodes: SceneNode[] = [];
  for (const child of spec.children) {
    if (abortRequested) break;
    const childNode = await assembleNode(child);
    if (childNode) {
      frame.appendChild(childNode);
      childNodes.push(childNode);
    }
  }

  // Apply deferred FILL on children
  for (const child of childNodes) {
    const deferred = deferredFills.get(child);
    if (deferred) {
      if (deferred.fillWidth) applyWidth(child, "fill");
      if (deferred.fillHeight) applyHeight(child, "fill");
      deferredFills.delete(child);
    }
  }

  // Apply own sizing
  const needsDeferWidth = spec.width === "fill";
  const needsDeferHeight = spec.height === "fill";
  if (!needsDeferWidth && spec.width !== undefined)
    applyWidth(frame, spec.width);
  if (!needsDeferHeight && spec.height !== undefined)
    applyHeight(frame, spec.height);
  if (needsDeferWidth || needsDeferHeight) {
    deferredFills.set(frame, {
      fillWidth: needsDeferWidth,
      fillHeight: needsDeferHeight,
    });
  }

  nodeCount++;
  sendProgress(nodeCount, totalNodes);
  if (nodeCount % 5 === 0) await yieldToMain();

  return frame;
}

async function assembleInstance(spec: SpecInstance): Promise<SceneNode | null> {
  if (abortRequested) return null;

  const entry = lookupComponent(spec.component);
  if (!entry) {
    sendLog(`Warning: "${spec.component}" not in registry — skipped`, "error");
    nodeCount++;
    sendProgress(nodeCount, totalNodes);
    return null;
  }

  try {
    let instance: InstanceNode;

    if (Object.keys(entry.variants).length > 0) {
      const componentSet = await cachedImportComponentSet(entry.key);
      instance = componentSet.defaultVariant.createInstance();
    } else {
      const component = await cachedImportComponent(entry.key);
      instance = component.createInstance();
    }

    sendLog(`OK: ${spec.component}`);

    if (spec.props) {
      const resolved = resolveVariantProps(entry, spec.props);
      if (Object.keys(resolved).length > 0) {
        try {
          instance.setProperties(resolved);
        } catch (err) {
          sendLog(`  variant failed: ${(err as Error).message}`, "error");
        }
      }
    }

    if (spec.text) {
      const resolved = resolveTextProps(entry, spec.text);
      for (const [propName, value] of Object.entries(resolved)) {
        try {
          instance.setProperties({ [propName]: value });
        } catch (err) {
          sendLog(`  text failed: ${(err as Error).message}`, "error");
        }
      }
    }

    const needsDeferWidth = spec.width === "fill";
    const needsDeferHeight = spec.height === "fill";
    if (!needsDeferWidth && spec.width !== undefined)
      applyWidth(instance, spec.width);
    if (!needsDeferHeight && spec.height !== undefined)
      applyHeight(instance, spec.height);
    if (needsDeferWidth || needsDeferHeight) {
      deferredFills.set(instance, {
        fillWidth: needsDeferWidth,
        fillHeight: needsDeferHeight,
      });
    }

    nodeCount++;
    sendProgress(nodeCount, totalNodes);
    if (nodeCount % 5 === 0) await yieldToMain();

    return instance;
  } catch (err) {
    sendLog(`Failed: "${spec.component}": ${(err as Error).message}`, "error");
    nodeCount++;
    sendProgress(nodeCount, totalNodes);
    return null;
  }
}

async function assembleNode(spec: SpecNode): Promise<SceneNode | null> {
  if (isInstance(spec)) return assembleInstance(spec);
  return assembleFrame(spec);
}

// ── Plugin entry point ───────────────────────────────────────
figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: 380, height: 520 });

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "cancel") {
    abortRequested = true;
    cancelAnalysis();
    cancelUpdate();
    return;
  }

  if (msg.type === "load-registry") {
    registry = msg.registry as Registry;
    tokenMap = msg.tokenMap || {};
    setAnalyzerRegistry(registry);
    setUpdaterRegistry(registry);
    setCreatorRegistry(registry);
    const compCount = Object.keys(registry.components).length;
    const tokenCount = Object.keys(tokenMap).length;
    sendLog(`Registry: ${compCount} components, ${tokenCount} tokens`);
    figma.ui.postMessage({
      type: "registry-loaded",
      components: compCount,
      tokens: tokenCount,
    });
    return;
  }

  if (msg.type === "analyze") {
    const scope: "selection" | "page" | "file" = msg.scope || "page";
    sendLog(`Starting analysis (scope: ${scope})...`);
    figma.ui.postMessage({ type: "phase", phase: "analyzing" });

    try {
      const result = await analyzeScope(scope);
      sendLog(
        `Analysis complete: ${result.stats.instances} instances, ${result.issues.length} issues`,
      );
      figma.ui.postMessage({ type: "analysis-done", result });
    } catch (err) {
      figma.ui.postMessage({
        type: "error",
        text: `Analysis failed: ${(err as Error).message}`,
      });
    }
    return;
  }

  if (msg.type === "apply-updates") {
    const instructions = msg.instructions as UpdateInstruction[];
    if (!instructions || instructions.length === 0) {
      figma.ui.postMessage({
        type: "error",
        text: "No update instructions provided.",
      });
      return;
    }

    sendLog(`Applying ${instructions.length} updates...`);
    figma.ui.postMessage({
      type: "phase",
      phase: "updating",
      total: instructions.length,
    });

    try {
      const result = await applyUpdates(instructions);
      sendLog(
        `Updates complete: ${result.applied} applied, ${result.failed} failed, ${result.skipped} skipped (${result.durationMs}ms)`,
      );
      figma.ui.postMessage({ type: "update-done", result });
    } catch (err) {
      figma.ui.postMessage({
        type: "error",
        text: `Updates failed: ${(err as Error).message}`,
      });
    }
    return;
  }

  if (msg.type === "create-component") {
    var spec = msg.spec as ComponentSpec;
    sendLog("Creating component from spec...");
    try {
      var result = await createComponentFromSpec(spec);
      figma.currentPage.appendChild(result);
      figma.viewport.scrollAndZoomIntoView([result]);
      figma.ui.postMessage({
        type: "create-done",
        text: "Component created: " + spec.name,
      });
    } catch (err) {
      figma.ui.postMessage({
        type: "error",
        text: "Create failed: " + (err as Error).message,
      });
    }
    return;
  }

  if (msg.type === "assemble") {
    const spec = msg.spec as SpecNode;

    // Reset state
    abortRequested = false;
    nodeCount = 0;
    totalNodes = countNodes(spec);
    deferredFills.clear();

    // Pre-scan unique components
    const uniqueKeys = collectUniqueKeys(spec);
    sendLog(`Spec: ${totalNodes} nodes, ${uniqueKeys.size} unique components`);
    sendLog("Pre-importing components...");
    figma.ui.postMessage({
      type: "phase",
      phase: "importing",
      total: uniqueKeys.size,
    });

    // Pre-warm cache
    let importCount = 0;
    for (const [, info] of uniqueKeys) {
      if (abortRequested) break;
      try {
        if (info.hasVariants) {
          await cachedImportComponentSet(info.key);
        } else {
          await cachedImportComponent(info.key);
        }
        importCount++;
        figma.ui.postMessage({
          type: "import-progress",
          current: importCount,
          total: uniqueKeys.size,
        });
      } catch (err) {
        sendLog(`Failed to pre-import: ${(err as Error).message}`, "error");
      }
      await yieldToMain();
    }

    if (abortRequested) {
      figma.ui.postMessage({ type: "error", text: "Cancelled." });
      return;
    }

    sendLog(
      `Imported ${importCount}/${uniqueKeys.size} components. Assembling...`,
    );
    figma.ui.postMessage({
      type: "phase",
      phase: "assembling",
      total: totalNodes,
    });

    try {
      const root = await assembleNode(spec);
      if (root && !abortRequested) {
        figma.currentPage.appendChild(root);
        const deferred = deferredFills.get(root);
        if (deferred) {
          if (deferred.fillWidth) applyWidth(root, "fill");
          if (deferred.fillHeight) applyHeight(root, "fill");
          deferredFills.delete(root);
        }
        figma.viewport.scrollAndZoomIntoView([root]);
        figma.ui.postMessage({
          type: "done",
          text: `Done! ${nodeCount} nodes assembled.`,
        });
      } else if (abortRequested) {
        figma.ui.postMessage({ type: "error", text: "Cancelled." });
      } else {
        figma.ui.postMessage({
          type: "error",
          text: "Assembly produced no output.",
        });
      }
    } catch (err) {
      figma.ui.postMessage({
        type: "error",
        text: `Assembly failed: ${(err as Error).message}`,
      });
    }
  }
};
