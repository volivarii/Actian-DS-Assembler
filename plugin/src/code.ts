import { lookupComponent, resolveVariantProps, resolveTextProps, resolveColor, getRegistryStats, hasVariants } from './registry';

interface SpecFrame {
  type: 'frame';
  name?: string;
  layout: 'vertical' | 'horizontal';
  spacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  fill?: string;
  width?: number | 'hug' | 'fill';
  height?: number | 'hug' | 'fill';
  align?: 'min' | 'center' | 'max' | 'space-between';
  counterAlign?: 'min' | 'center' | 'max';
  cornerRadius?: number;
  children: SpecNode[];
}

interface SpecInstance {
  component: string;
  props?: Record<string, string>;
  text?: Record<string, string>;
  width?: number | 'hug' | 'fill';
  height?: number | 'hug' | 'fill';
}

type SpecNode = SpecFrame | SpecInstance;

function isInstance(node: SpecNode): node is SpecInstance {
  return 'component' in node;
}

const ALIGN_MAP = {
  'min': 'MIN',
  'center': 'CENTER',
  'max': 'MAX',
  'space-between': 'SPACE_BETWEEN',
} as const;

const COUNTER_ALIGN_MAP = {
  'min': 'MIN',
  'center': 'CENTER',
  'max': 'MAX',
} as const;

function applySizing(node: SceneNode, width: number | 'hug' | 'fill' | undefined, height: number | 'hug' | 'fill' | undefined) {
  const n = node as any;
  if (typeof width === 'number') {
    n.resize(width, n.height);
    n.layoutSizingHorizontal = 'FIXED';
  } else if (width === 'fill') {
    n.layoutSizingHorizontal = 'FILL';
  } else {
    n.layoutSizingHorizontal = 'HUG';
  }

  if (typeof height === 'number') {
    n.resize(n.width, height);
    n.layoutSizingVertical = 'FIXED';
  } else if (height === 'fill') {
    n.layoutSizingVertical = 'FILL';
  } else {
    n.layoutSizingVertical = 'HUG';
  }
}

// Deferred sizing map — Figma nodes are frozen, can't add properties to them
const deferredSizing = new Map<SceneNode, { width?: number | 'hug' | 'fill'; height?: number | 'hug' | 'fill' }>();

function sendLog(text: string, level?: string) {
  figma.ui.postMessage({ type: 'log', text, level });
}

async function assembleFrame(spec: SpecFrame): Promise<SceneNode> {
  const frame = figma.createFrame();
  frame.name = spec.name || 'Frame';

  frame.layoutMode = spec.layout === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  frame.itemSpacing = spec.spacing || 0;

  if (spec.padding) {
    frame.paddingTop = spec.padding.top || 0;
    frame.paddingRight = spec.padding.right || 0;
    frame.paddingBottom = spec.padding.bottom || 0;
    frame.paddingLeft = spec.padding.left || 0;
  }

  if (spec.fill) {
    const color = resolveColor(spec.fill);
    if (color) {
      frame.fills = [{ type: 'SOLID', color }];
    }
  } else {
    frame.fills = [];
  }

  if (spec.align) {
    frame.primaryAxisAlignItems = ALIGN_MAP[spec.align] || 'MIN';
  }
  if (spec.counterAlign) {
    frame.counterAxisAlignItems = COUNTER_ALIGN_MAP[spec.counterAlign] || 'MIN';
  }

  if (spec.cornerRadius) {
    frame.cornerRadius = spec.cornerRadius;
  }

  const childNodes: SceneNode[] = [];
  for (const child of spec.children) {
    const childNode = await assembleNode(child);
    if (childNode) {
      frame.appendChild(childNode);
      childNodes.push(childNode);
    }
  }

  // Apply deferred sizing on children now that they're in an auto-layout parent
  for (const child of childNodes) {
    const deferred = deferredSizing.get(child);
    if (deferred) {
      applySizing(child, deferred.width, deferred.height);
      deferredSizing.delete(child);
    }
  }

  // Apply non-FILL sizing immediately; defer FILL until after appendChild
  const hasHorizontalFill = spec.width === 'fill';
  const hasVerticalFill = spec.height === 'fill';

  if (hasHorizontalFill || hasVerticalFill) {
    // Defer FILL sizing — needs to be in an auto-layout parent first
    deferredSizing.set(frame, { width: spec.width, height: spec.height });
  } else {
    applySizing(frame, spec.width, spec.height);
  }

  return frame;
}

async function assembleInstance(spec: SpecInstance): Promise<SceneNode | null> {
  const entry = lookupComponent(spec.component);
  if (!entry) {
    sendLog(`Warning: Component not in registry: "${spec.component}" — skipped`, 'error');
    return null;
  }

  try {
    let instance: InstanceNode;

    if (hasVariants(entry)) {
      // Component set: import the set, then create instance from default variant
      const componentSet = await figma.importComponentSetByKeyAsync(entry.key);
      const defaultVariant = componentSet.defaultVariant;
      instance = defaultVariant.createInstance();
    } else {
      // Standalone component: import directly
      const component = await figma.importComponentByKeyAsync(entry.key);
      instance = component.createInstance();
    }

    sendLog(`OK: ${spec.component}`);

    if (spec.props) {
      const resolved = resolveVariantProps(entry, spec.props);
      if (Object.keys(resolved).length > 0) {
        instance.setProperties(resolved);
      }
    }

    if (spec.text) {
      const resolved = resolveTextProps(entry, spec.text);
      for (const [propName, value] of Object.entries(resolved)) {
        instance.setProperties({ [propName]: value });
      }
    }

    // Store sizing spec — will be applied after appendChild
    if (spec.width || spec.height) {
      deferredSizing.set(instance, { width: spec.width, height: spec.height });
    }

    return instance;
  } catch (err) {
    sendLog(`Failed to import "${spec.component}": ${(err as Error).message}`, 'error');
    return null;
  }
}

async function assembleNode(spec: SpecNode): Promise<SceneNode | null> {
  if (isInstance(spec)) {
    return assembleInstance(spec);
  }
  return assembleFrame(spec);
}

figma.showUI(__html__, { width: 360, height: 400 });

const stats = getRegistryStats();
sendLog(`Registry loaded: ${stats.total} components (${stats.fatMarker} FM, ${stats.ds2026} DS2026)`);

figma.ui.onmessage = async (msg: any) => {
  if (msg.type !== 'assemble') return;

  const spec = msg.spec as SpecNode;
  sendLog('Assembling...');

  try {
    const root = await assembleNode(spec);
    if (root) {
      figma.currentPage.appendChild(root);
      // Apply deferred sizing on root if needed
      const deferred = deferredSizing.get(root);
      if (deferred) {
        applySizing(root, deferred.width, deferred.height);
        deferredSizing.delete(root);
      }
      figma.viewport.scrollAndZoomIntoView([root]);
      figma.ui.postMessage({
        type: 'done',
        text: 'Done! Frame added to page.'
      });
    } else {
      figma.ui.postMessage({ type: 'error', text: 'Assembly produced no output.' });
    }
  } catch (err) {
    figma.ui.postMessage({ type: 'error', text: `Assembly failed: ${(err as Error).message}` });
  }
};
