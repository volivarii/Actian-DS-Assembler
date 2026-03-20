import { lookupComponent, resolveVariantProps, resolveTextProps, resolveColor, getRegistryStats } from './registry';

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

  for (const child of spec.children) {
    const childNode = await assembleNode(child);
    if (childNode) {
      frame.appendChild(childNode);
    }
  }

  applySizing(frame, spec.width, spec.height);

  return frame;
}

async function assembleInstance(spec: SpecInstance): Promise<SceneNode | null> {
  const entry = lookupComponent(spec.component);
  if (!entry) {
    sendLog(`Warning: Component not in registry: "${spec.component}" — skipped`, 'error');
    return null;
  }

  try {
    const component = await figma.importComponentByKeyAsync(entry.key);
    const instance = component.createInstance();
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

    if (spec.width || spec.height) {
      applySizing(instance, spec.width, spec.height);
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
