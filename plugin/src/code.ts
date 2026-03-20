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

// Apply a single dimension of sizing. Only call when node is in the right context.
function applyWidth(node: SceneNode, width: number | 'hug' | 'fill' | undefined) {
  if (width === undefined) return;
  const n = node as any;
  if (typeof width === 'number') {
    n.resize(width, n.height);
    n.layoutSizingHorizontal = 'FIXED';
  } else if (width === 'fill') {
    n.layoutSizingHorizontal = 'FILL';
  } else if (width === 'hug') {
    try { n.layoutSizingHorizontal = 'HUG'; } catch (_) {}
  }
}

function applyHeight(node: SceneNode, height: number | 'hug' | 'fill' | undefined) {
  if (height === undefined) return;
  const n = node as any;
  if (typeof height === 'number') {
    n.resize(n.width, height);
    n.layoutSizingVertical = 'FIXED';
  } else if (height === 'fill') {
    n.layoutSizingVertical = 'FILL';
  } else if (height === 'hug') {
    try { n.layoutSizingVertical = 'HUG'; } catch (_) {}
  }
}

// Track which nodes need FILL applied after they're appended to an auto-layout parent
const deferredFills = new Map<SceneNode, { fillWidth: boolean; fillHeight: boolean }>();

function sendLog(text: string, level?: string) {
  figma.ui.postMessage({ type: 'log', text, level });
}

async function assembleFrame(spec: SpecFrame): Promise<SceneNode> {
  const frame = figma.createFrame();
  frame.name = spec.name || 'Frame';

  // Set auto-layout
  frame.layoutMode = spec.layout === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  frame.itemSpacing = spec.spacing || 0;

  // Default to HUG on both axes (Figma defaults to FIXED 100x100)
  frame.layoutSizingHorizontal = 'HUG';
  frame.layoutSizingVertical = 'HUG';

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

  // Process children
  const childNodes: SceneNode[] = [];
  for (const child of spec.children) {
    const childNode = await assembleNode(child);
    if (childNode) {
      frame.appendChild(childNode);
      childNodes.push(childNode);
    }
  }

  // Apply deferred FILL sizing on children — now they're in this auto-layout frame
  for (const child of childNodes) {
    const deferred = deferredFills.get(child);
    if (deferred) {
      if (deferred.fillWidth) applyWidth(child, 'fill');
      if (deferred.fillHeight) applyHeight(child, 'fill');
      deferredFills.delete(child);
    }
  }

  // Apply own sizing: FIXED and HUG immediately, defer FILL
  const needsDeferWidth = spec.width === 'fill';
  const needsDeferHeight = spec.height === 'fill';

  // Apply non-fill dimensions immediately
  if (!needsDeferWidth && spec.width !== undefined) {
    applyWidth(frame, spec.width);
  }
  if (!needsDeferHeight && spec.height !== undefined) {
    applyHeight(frame, spec.height);
  }

  // Defer fill dimensions until this frame is appended to a parent
  if (needsDeferWidth || needsDeferHeight) {
    deferredFills.set(frame, { fillWidth: needsDeferWidth, fillHeight: needsDeferHeight });
  }

  return frame;
}

async function assembleInstance(spec: SpecInstance): Promise<SceneNode | null> {
  const entry = lookupComponent(spec.component);
  if (!entry) {
    sendLog(`Warning: "${spec.component}" not in registry — skipped`, 'error');
    return null;
  }

  try {
    let instance: InstanceNode;

    if (hasVariants(entry)) {
      const componentSet = await figma.importComponentSetByKeyAsync(entry.key);
      const defaultVariant = componentSet.defaultVariant;
      instance = defaultVariant.createInstance();
    } else {
      const component = await figma.importComponentByKeyAsync(entry.key);
      instance = component.createInstance();
    }

    sendLog(`OK: ${spec.component}`);

    // Set variant properties
    if (spec.props) {
      const resolved = resolveVariantProps(entry, spec.props);
      if (Object.keys(resolved).length > 0) {
        try {
          instance.setProperties(resolved);
        } catch (err) {
          sendLog(`  variant override failed: ${(err as Error).message}`, 'error');
        }
      }
    }

    // Set text overrides
    if (spec.text) {
      const resolved = resolveTextProps(entry, spec.text);
      for (const [propName, value] of Object.entries(resolved)) {
        try {
          instance.setProperties({ [propName]: value });
        } catch (err) {
          sendLog(`  text override failed for "${propName}": ${(err as Error).message}`, 'error');
        }
      }
    }

    // Defer FILL sizing, apply non-fill immediately
    const needsDeferWidth = spec.width === 'fill';
    const needsDeferHeight = spec.height === 'fill';

    if (!needsDeferWidth && spec.width !== undefined) {
      applyWidth(instance, spec.width);
    }
    if (!needsDeferHeight && spec.height !== undefined) {
      applyHeight(instance, spec.height);
    }

    if (needsDeferWidth || needsDeferHeight) {
      deferredFills.set(instance, { fillWidth: needsDeferWidth, fillHeight: needsDeferHeight });
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

// Plugin entry point
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
      // Apply deferred FILL on root if needed
      const deferred = deferredFills.get(root);
      if (deferred) {
        if (deferred.fillWidth) applyWidth(root, 'fill');
        if (deferred.fillHeight) applyHeight(root, 'fill');
        deferredFills.delete(root);
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
