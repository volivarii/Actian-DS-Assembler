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

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms importing ${label}`)),
        ms,
      ),
    ),
  ]);
}

async function cachedImportComponent(key: string): Promise<ComponentNode> {
  let c = componentCache.get(key);
  if (!c) {
    c = await withTimeout(figma.importComponentByKeyAsync(key), 15000, key);
    componentCache.set(key, c);
  }
  return c;
}

async function cachedImportComponentSet(
  key: string,
): Promise<ComponentSetNode> {
  let cs = componentSetCache.get(key);
  if (!cs) {
    cs = await withTimeout(figma.importComponentSetByKeyAsync(key), 15000, key);
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

function countNodes(spec: any): number {
  if (!spec) return 0;
  if (isInstance(spec)) return 1;
  if (!spec.children) return 1; // text nodes, shapes, etc.
  return (
    1 + spec.children.reduce((sum: number, c: any) => sum + countNodes(c), 0)
  );
}

function collectUniqueKeys(
  spec: any,
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
  } else if (spec.children) {
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

    // Boolean overrides (e.g., hide leading/trailing icons)
    const boolOverrides = spec.booleanOverrides || spec.boolean;
    if (boolOverrides) {
      for (const [shortName, value] of Object.entries(boolOverrides)) {
        // Find the full property name from registry booleanProperties
        // Match strategies: exact, strip emoji prefix, partial/endsWith
        const boolProps = entry.booleanProperties || [];
        let fullName = boolProps.find(
          (bp: string) => bp.split("#")[0].trim() === shortName,
        );
        // Strip emoji prefix (e.g., "👁 Leading Icon" → "Leading Icon")
        if (!fullName) {
          fullName = boolProps.find((bp: string) => {
            const clean = bp
              .split("#")[0]
              .trim()
              .replace(/^[^\w\s]+\s*/, "");
            return clean === shortName;
          });
        }
        // Partial match (shortName appears in property name)
        if (!fullName) {
          fullName = boolProps.find((bp: string) =>
            bp.toLowerCase().includes(shortName.toLowerCase()),
          );
        }
        if (fullName) {
          try {
            instance.setProperties({ [fullName]: value as boolean });
          } catch (err) {
            sendLog(
              `  boolean failed for "${shortName}": ${(err as Error).message}`,
              "error",
            );
          }
        } else {
          // Try direct match (user provided full name)
          try {
            instance.setProperties({ [shortName]: value as boolean });
          } catch (err) {
            sendLog(`  boolean "${shortName}" not found in registry`, "error");
          }
        }
      }
    }

    const textOverrides = spec.text || spec.textOverrides;
    if (textOverrides) {
      const resolved = resolveTextProps(entry, textOverrides);
      if (Object.keys(resolved).length > 0) {
        // Use component properties (exposed text props)
        for (const [propName, value] of Object.entries(resolved)) {
          try {
            instance.setProperties({ [propName]: value });
          } catch (err) {
            sendLog(`  text prop failed: ${(err as Error).message}`, "error");
          }
        }
      } else {
        // Fallback: find text nodes by name inside the instance (including nested instances)
        // Support two formats:
        //   "Label": "text"          → find text node named "Label" anywhere in tree
        //   "Tab 1": "General"       → find Nth nested instance and override its text
        const allTextNodes = instance.findAll(
          (n: any) => n.type === "TEXT",
        ) as TextNode[];

        // Build a map of numbered keys (e.g., "Tab 1", "Tab 2") for sequential override
        const numberedEntries: Array<[string, string, number]> = [];
        const directEntries: Array<[string, string]> = [];

        for (const [name, value] of Object.entries(textOverrides)) {
          const match = name.match(/^(.+?)\s*(\d+)$/);
          if (match) {
            numberedEntries.push([
              match[1].trim(),
              value as string,
              parseInt(match[2]),
            ]);
          } else {
            directEntries.push([name, value as string]);
          }
        }

        // Handle direct text overrides (find by name)
        // If only one override and only one text node, apply regardless of name
        if (directEntries.length === 1 && allTextNodes.length === 1) {
          try {
            await figma.loadFontAsync(allTextNodes[0].fontName as FontName);
            allTextNodes[0].characters = directEntries[0][1];
          } catch (err) {
            sendLog(
              `  text override failed: ${(err as Error).message}`,
              "error",
            );
          }
        } else {
          for (const [name, value] of directEntries) {
            try {
              // Exact match first
              let textNode =
                allTextNodes.find(
                  (n) => n.name.split("#")[0].trim() === name,
                ) || null;
              // Partial match
              if (!textNode) {
                textNode =
                  allTextNodes.find((n) =>
                    n.name.toLowerCase().includes(name.toLowerCase()),
                  ) || null;
              }
              // Last resort: if this is the only unmatched override and there's a text node, use it
              if (!textNode && allTextNodes.length > 0) {
                textNode = allTextNodes[0];
              }
              if (textNode) {
                await figma.loadFontAsync(textNode.fontName as FontName);
                textNode.characters = value;
              }
            } catch (err) {
              sendLog(
                `  text override failed for "${name}": ${(err as Error).message}`,
                "error",
              );
            }
          }
        }

        // Handle numbered overrides (e.g., "Tab 1", "Tab 2", "Tab 3")
        // Find nested instances and override their text sequentially
        if (numberedEntries.length > 0) {
          const nestedInstances = instance.findAll(
            (n: any) => n.type === "INSTANCE",
          ) as InstanceNode[];

          for (const [baseName, value, index] of numberedEntries) {
            try {
              // index is 1-based
              const targetInstance = nestedInstances[index - 1];
              if (targetInstance) {
                // Find the first text node in this nested instance
                const nestedText = targetInstance.findOne(
                  (n: any) => n.type === "TEXT",
                ) as TextNode | null;
                if (nestedText) {
                  await figma.loadFontAsync(nestedText.fontName as FontName);
                  nestedText.characters = value;
                }
              }
            } catch (err) {
              sendLog(
                `  text override failed for "${baseName} ${index}": ${(err as Error).message}`,
                "error",
              );
            }
          }
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

async function assembleTextNode(spec: any): Promise<SceneNode | null> {
  const TEXT_STYLES: Record<
    string,
    { size: number; lineHeight: number; weight: number }
  > = {
    "heading-display": { size: 24, lineHeight: 32, weight: 600 },
    "heading-prominent": { size: 18, lineHeight: 24, weight: 600 },
    "heading-standard": { size: 16, lineHeight: 22, weight: 600 },
    "heading-subtle": { size: 14, lineHeight: 20, weight: 600 },
    "body-standard": { size: 14, lineHeight: 20, weight: 400 },
    "body-subtle": { size: 12, lineHeight: 16, weight: 400 },
    "label-standard": { size: 14, lineHeight: 20, weight: 500 },
    "label-subtle": { size: 12, lineHeight: 16, weight: 500 },
    "label-micro": { size: 11, lineHeight: 14, weight: 500 },
  };
  function weightToStyle(w: number): string {
    if (w >= 600) return "Semi Bold";
    if (w >= 500) return "Medium";
    return "Regular";
  }

  const node = figma.createText();
  const styleDef =
    TEXT_STYLES[spec.style || "body-standard"] || TEXT_STYLES["body-standard"];
  const family = "Inter";
  await figma.loadFontAsync({ family, style: weightToStyle(styleDef.weight) });
  node.fontName = { family, style: weightToStyle(styleDef.weight) };
  node.fontSize = styleDef.size;
  node.lineHeight = { value: styleDef.lineHeight, unit: "PIXELS" };
  node.characters = spec.content || "Text";
  if (spec.name) node.name = spec.name;
  if (spec.fill) {
    const hex = spec.fill.replace("#", "");
    node.fills = [
      {
        type: "SOLID",
        color: {
          r: parseInt(hex.substring(0, 2), 16) / 255,
          g: parseInt(hex.substring(2, 4), 16) / 255,
          b: parseInt(hex.substring(4, 6), 16) / 255,
        },
      },
    ];
  }
  if (spec.width === "fill") {
    deferredFills.set(node, { fillWidth: true, fillHeight: false });
  } else if (typeof spec.width === "number") {
    node.resize(spec.width, node.height);
    (node as any).textAutoResize = "HEIGHT";
  }
  nodeCount++;
  sendProgress(nodeCount, totalNodes);
  return node;
}

async function assembleNode(spec: any): Promise<SceneNode | null> {
  if (isInstance(spec)) return assembleInstance(spec);
  if (spec.type === "text") return assembleTextNode(spec);
  if (spec.children) return assembleFrame(spec);
  sendLog(
    `Unknown node type: ${JSON.stringify(spec).substring(0, 100)}`,
    "error",
  );
  return null;
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
    sendLog("Assemble message received");
    try {
      const spec = msg.spec as SpecNode;

      // Reset state
      abortRequested = false;
      nodeCount = 0;
      totalNodes = countNodes(spec);
      deferredFills.clear();

      // Pre-scan unique components
      const uniqueKeys = collectUniqueKeys(spec);
      sendLog(
        `Spec: ${totalNodes} nodes, ${uniqueKeys.size} unique components`,
      );
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
    } catch (outerErr) {
      sendLog(`FATAL: ${(outerErr as Error).message}`, "error");
      figma.ui.postMessage({
        type: "error",
        text: `Assemble crashed: ${(outerErr as Error).message}`,
      });
    }
  }
};
