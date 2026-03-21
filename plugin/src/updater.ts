// DS Assembler — Updater: applies update instructions to Figma nodes

import { Registry, UpdateInstruction, UpdateResult } from './types';

let registry: Registry | null = null;
let abortUpdate = false;

// ── Component import cache ──────────────────────────────────
const importCache = new Map<string, ComponentNode>();
const importSetCache = new Map<string, ComponentSetNode>();

async function cachedImport(key: string): Promise<ComponentNode> {
  let c = importCache.get(key);
  if (!c) {
    c = await figma.importComponentByKeyAsync(key);
    importCache.set(key, c);
  }
  return c;
}

async function cachedImportSet(key: string): Promise<ComponentSetNode> {
  let cs = importSetCache.get(key);
  if (!cs) {
    cs = await figma.importComponentSetByKeyAsync(key);
    importSetCache.set(key, cs);
  }
  return cs;
}

// ── Public API ──────────────────────────────────────────────

/** Set the registry so updater can resolve component names. */
export function setUpdaterRegistry(reg: Registry) {
  registry = reg;
}

/** Signal the updater to stop early. */
export function cancelUpdate() {
  abortUpdate = true;
}

function yieldToMain(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function sendLog(text: string, level?: string) {
  figma.ui.postMessage({ type: 'log', text, level });
}

/** Resolve a component name from registry to its key, or use a raw key. */
function resolveComponentKey(nameOrKey: string): string | null {
  if (!registry) return nameOrKey; // treat as raw key
  const entry = registry.components[nameOrKey];
  if (entry) return entry.key;
  // Check if it's already a key
  for (const e of Object.values(registry.components)) {
    if (e.key === nameOrKey) return nameOrKey;
  }
  return null;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255,
  };
}

// ── Instruction handlers ────────────────────────────────────

async function applySetVariant(node: SceneNode, props: Record<string, string>): Promise<string> {
  if (node.type !== 'INSTANCE') return 'Node is not an instance';
  try {
    (node as InstanceNode).setProperties(props);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applySetText(node: SceneNode, property: string, value: string): Promise<string> {
  if (node.type !== 'INSTANCE') return 'Node is not an instance';
  try {
    (node as InstanceNode).setProperties({ [property]: value });
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applySwapComponent(node: SceneNode, newComponentKey: string): Promise<string> {
  if (node.type !== 'INSTANCE') return 'Node is not an instance';
  const key = resolveComponentKey(newComponentKey);
  if (!key) return `Component "${newComponentKey}" not found in registry`;
  try {
    const component = await cachedImport(key);
    (node as InstanceNode).swapComponent(component);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applyReplaceWithInstance(
  node: SceneNode,
  componentKey: string,
  variantProperties?: Record<string, string>
): Promise<string> {
  const key = resolveComponentKey(componentKey);
  if (!key) return `Component "${componentKey}" not found in registry`;
  try {
    // Import and create instance
    let instance: InstanceNode;
    const entry = registry ? Object.values(registry.components).find(e => e.key === key) : null;
    if (entry && Object.keys(entry.variants).length > 0) {
      const compSet = await cachedImportSet(key);
      instance = compSet.defaultVariant.createInstance();
    } else {
      const comp = await cachedImport(key);
      instance = comp.createInstance();
    }

    // Apply variant properties
    if (variantProperties && Object.keys(variantProperties).length > 0) {
      try { instance.setProperties(variantProperties); } catch (_) {}
    }

    // Position at same location
    instance.x = node.x;
    instance.y = node.y;

    // Insert in same parent, then remove old node
    const parent = node.parent;
    if (parent && 'children' in parent) {
      const idx = (parent as ChildrenMixin).children.indexOf(node as any);
      parent.insertChild(idx >= 0 ? idx : (parent as ChildrenMixin).children.length, instance);
    } else {
      figma.currentPage.appendChild(instance);
    }
    node.remove();
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applyDelete(node: SceneNode): Promise<string> {
  try {
    node.remove();
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applySetFill(node: SceneNode, color: string): Promise<string> {
  if (!('fills' in node)) return 'Node does not support fills';
  try {
    const rgb = hexToRgb(color);
    (node as GeometryMixin).fills = [{ type: 'SOLID', color: rgb }];
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

async function applySetAutoLayout(
  node: SceneNode,
  direction: 'HORIZONTAL' | 'VERTICAL',
  spacing?: number
): Promise<string> {
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT') return 'Node is not a frame or component';
  try {
    const frame = node as FrameNode;
    frame.layoutMode = direction;
    if (spacing !== undefined) frame.itemSpacing = spacing;
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

// ── Main update function ────────────────────────────────────

export async function applyUpdates(instructions: UpdateInstruction[]): Promise<UpdateResult> {
  abortUpdate = false;
  const startTime = Date.now();

  let applied = 0;
  let skipped = 0;
  const errors: UpdateResult['errors'] = [];
  const details: { nodeId: string; action: string; status: 'applied' | 'failed' | 'skipped'; message?: string }[] = [];

  const total = instructions.length;

  for (let i = 0; i < instructions.length; i++) {
    if (abortUpdate) {
      // Mark remaining as skipped
      for (let j = i; j < instructions.length; j++) {
        skipped++;
        details.push({ nodeId: instructions[j].nodeId, action: instructions[j].action, status: 'skipped', message: 'Cancelled' });
      }
      break;
    }

    const inst = instructions[i];

    // Progress every 5 updates
    if (i % 5 === 0) {
      figma.ui.postMessage({ type: 'update-progress', current: i, total });
      await yieldToMain();
    }

    // Fetch the node
    const node = await figma.getNodeByIdAsync(inst.nodeId) as SceneNode | null;
    if (!node) {
      skipped++;
      details.push({ nodeId: inst.nodeId, action: inst.action, status: 'skipped', message: 'Node not found' });
      continue;
    }

    let errorMsg = '';

    switch (inst.action) {
      case 'set-variant':
        errorMsg = await applySetVariant(node, inst.props || {});
        break;
      case 'set-text':
        errorMsg = await applySetText(node, inst.text ? Object.keys(inst.text)[0] : '', inst.text ? Object.values(inst.text)[0] : '');
        break;
      case 'swap-component':
        errorMsg = await applySwapComponent(node, inst.componentName || '');
        break;
      case 'replace-with-instance':
        errorMsg = await applyReplaceWithInstance(node, inst.componentName || '', inst.props);
        break;
      case 'delete':
        errorMsg = await applyDelete(node);
        break;
      case 'set-fill':
        errorMsg = await applySetFill(node, inst.fill || '#000000');
        break;
      case 'set-auto-layout':
        errorMsg = await applySetAutoLayout(
          node,
          inst.layout === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL',
          inst.spacing
        );
        break;
      default:
        errorMsg = `Unknown action: ${inst.action}`;
    }

    if (errorMsg) {
      errors.push({ nodeId: inst.nodeId, action: inst.action, error: errorMsg });
      details.push({ nodeId: inst.nodeId, action: inst.action, status: 'failed', message: errorMsg });
      sendLog(`Update failed [${inst.action}] ${inst.nodeId}: ${errorMsg}`, 'error');
    } else {
      applied++;
      details.push({ nodeId: inst.nodeId, action: inst.action, status: 'applied' });
    }
  }

  // Final progress
  figma.ui.postMessage({ type: 'update-progress', current: total, total });

  return {
    applied,
    failed: errors.length,
    skipped,
    details,
    durationMs: Date.now() - startTime,
  };
}
