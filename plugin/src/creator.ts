// DS Assembler — Component Creator module
// Creates new Figma components from ComponentSpec JSON definitions

import { Registry, ComponentEntry, ComponentChildNode, VariantDefinition, ComponentSpec } from './types';

// ── State ────────────────────────────────────────────────────
let registry: Registry | null = null;

const componentCache = new Map<string, ComponentNode>();
const componentSetCache = new Map<string, ComponentSetNode>();

export function setCreatorRegistry(reg: Registry) {
  registry = reg;
}

// ── Import cache (mirrors code.ts pattern) ───────────────────
async function cachedImportComponent(key: string): Promise<ComponentNode> {
  let c = componentCache.get(key);
  if (!c) {
    c = await figma.importComponentByKeyAsync(key);
    componentCache.set(key, c);
  }
  return c;
}

async function cachedImportComponentSet(key: string): Promise<ComponentSetNode> {
  let cs = componentSetCache.get(key);
  if (!cs) {
    cs = await figma.importComponentSetByKeyAsync(key);
    componentSetCache.set(key, cs);
  }
  return cs;
}

// ── Registry lookup ──────────────────────────────────────────
function lookupComponent(name: string): ComponentEntry | null {
  if (!registry) return null;
  var entry = registry.components[name];
  if (entry) return entry;
  return null;
}

// ── Helpers ──────────────────────────────────────────────────
function sendLog(text: string, level?: string) {
  figma.ui.postMessage({ type: 'log', text: text, level: level });
}

function hexToRgb(hex: string): RGB {
  var h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255,
  };
}

const ALIGN_MAP: Record<string, 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'> = {
  'min': 'MIN',
  'center': 'CENTER',
  'max': 'MAX',
  'space-between': 'SPACE_BETWEEN'
};

const COUNTER_ALIGN_MAP: Record<string, 'MIN' | 'CENTER' | 'MAX'> = {
  'min': 'MIN',
  'center': 'CENTER',
  'max': 'MAX'
};

// ── Text style mapping ───────────────────────────────────────
interface TextStyleDef {
  size: number;
  lineHeight: number;
  weight: number;
  letterSpacing?: number;
}

const TEXT_STYLES: Record<string, TextStyleDef> = {
  'heading-display':    { size: 24, lineHeight: 32, weight: 600 },
  'heading-prominent':  { size: 18, lineHeight: 24, weight: 600 },
  'heading-standard':   { size: 16, lineHeight: 22, weight: 600 },
  'heading-subtle':     { size: 14, lineHeight: 20, weight: 600 },
  'body-standard':      { size: 14, lineHeight: 20, weight: 400 },
  'body-subtle':        { size: 12, lineHeight: 16, weight: 400 },
  'label-standard':     { size: 14, lineHeight: 20, weight: 500 },
  'label-subtle':       { size: 12, lineHeight: 16, weight: 500 },
  'label-micro':        { size: 11, lineHeight: 14, weight: 500 },
};

function weightToStyle(weight: number): string {
  if (weight >= 600) return 'Semi Bold';
  if (weight >= 500) return 'Medium';
  return 'Regular';
}

function getFontFamily(library?: string): string {
  if (library === 'fat-marker') return 'Inter';
  return 'Roboto';
}

// ── Font loading ─────────────────────────────────────────────
export async function loadFonts(library?: string): Promise<void> {
  var family = getFontFamily(library);
  var styles = ['Regular', 'Medium', 'Semi Bold'];
  for (var i = 0; i < styles.length; i++) {
    try {
      await figma.loadFontAsync({ family: family, style: styles[i] });
    } catch (err) {
      sendLog('Font load warning: ' + family + ' ' + styles[i] + ' - ' + (err as Error).message, 'error');
    }
  }
}

// ── Sizing helpers ───────────────────────────────────────────
function applyWidth(node: SceneNode, width: number | 'hug' | 'fill' | undefined) {
  if (width === undefined) return;
  var n = node as any;
  if (typeof width === 'number') {
    n.resize(width, n.height);
    n.layoutSizingHorizontal = 'FIXED';
  } else if (width === 'fill') {
    n.layoutSizingHorizontal = 'FILL';
  } else if (width === 'hug') {
    try { n.layoutSizingHorizontal = 'HUG'; } catch (_) { /* ignore */ }
  }
}

function applyHeight(node: SceneNode, height: number | 'hug' | 'fill' | undefined) {
  if (height === undefined) return;
  var n = node as any;
  if (typeof height === 'number') {
    n.resize(n.width, height);
    n.layoutSizingVertical = 'FIXED';
  } else if (height === 'fill') {
    n.layoutSizingVertical = 'FILL';
  } else if (height === 'hug') {
    try { n.layoutSizingVertical = 'HUG'; } catch (_) { /* ignore */ }
  }
}

// ── Deferred FILL sizing ─────────────────────────────────────
var deferredFills = new Map<SceneNode, { fillWidth: boolean; fillHeight: boolean }>();

function deferOrApplyWidth(node: SceneNode, width: number | 'hug' | 'fill' | undefined) {
  if (width === 'fill') {
    var existing = deferredFills.get(node) || { fillWidth: false, fillHeight: false };
    existing.fillWidth = true;
    deferredFills.set(node, existing);
  } else {
    applyWidth(node, width);
  }
}

function deferOrApplyHeight(node: SceneNode, height: number | 'hug' | 'fill' | undefined) {
  if (height === 'fill') {
    var existing = deferredFills.get(node) || { fillWidth: false, fillHeight: false };
    existing.fillHeight = true;
    deferredFills.set(node, existing);
  } else {
    applyHeight(node, height);
  }
}

function applyDeferredFills(children: SceneNode[]) {
  for (var i = 0; i < children.length; i++) {
    var deferred = deferredFills.get(children[i]);
    if (deferred) {
      if (deferred.fillWidth) applyWidth(children[i], 'fill');
      if (deferred.fillHeight) applyHeight(children[i], 'fill');
      deferredFills.delete(children[i]);
    }
  }
}

// ── Create text node ─────────────────────────────────────────
async function createTextNode(spec: ComponentChildNode, library?: string): Promise<TextNode> {
  var node = figma.createText();
  var family = getFontFamily(library);
  var styleName = spec.style || 'body-standard';
  var styleDef = TEXT_STYLES[styleName];
  if (!styleDef) {
    styleDef = TEXT_STYLES['body-standard'];
  }

  var fontStyle = weightToStyle(styleDef.weight);
  node.fontName = { family: family, style: fontStyle };
  node.fontSize = styleDef.size;
  node.lineHeight = { value: styleDef.lineHeight, unit: 'PIXELS' };
  if (styleDef.letterSpacing) {
    node.letterSpacing = { value: styleDef.letterSpacing, unit: 'PIXELS' };
  }

  var content = spec.content || 'Text';
  node.characters = content;

  if (spec.name) {
    node.name = spec.name;
  }

  if (spec.fill) {
    var color = hexToRgb(spec.fill);
    node.fills = [{ type: 'SOLID', color: color }];
  }

  return node;
}

// ── Build child node (recursive) ─────────────────────────────
async function buildChildNode(spec: ComponentChildNode, library?: string): Promise<SceneNode | null> {
  // Text node
  if (spec.type === 'text') {
    return createTextNode(spec, library);
  }

  // Nested component instance
  if (spec.component) {
    var entry = lookupComponent(spec.component);
    if (!entry) {
      sendLog('Warning: "' + spec.component + '" not in registry — skipped', 'error');
      return null;
    }

    try {
      var instance: InstanceNode;
      var hasVariants = Object.keys(entry.variants).length > 0;

      if (hasVariants) {
        var componentSet = await cachedImportComponentSet(entry.key);
        instance = componentSet.defaultVariant.createInstance();
      } else {
        var component = await cachedImportComponent(entry.key);
        instance = component.createInstance();
      }

      // Apply variant props
      if (spec.props) {
        var resolved: Record<string, string> = {};
        for (var shortName in spec.props) {
          if (spec.props.hasOwnProperty(shortName)) {
            var fullName = entry.variantShortNames[shortName];
            if (fullName) {
              resolved[fullName] = spec.props[shortName];
            }
          }
        }
        if (Object.keys(resolved).length > 0) {
          try { instance.setProperties(resolved); }
          catch (err) { sendLog('  variant failed: ' + (err as Error).message, 'error'); }
        }
      }

      // Apply text props
      if (spec.text) {
        for (var textShort in spec.text) {
          if (spec.text.hasOwnProperty(textShort)) {
            var textFull = entry.textProperties.find(function(tp: string) { return tp.split('#')[0] === textShort; });
            if (textFull) {
              try { instance.setProperties({ [textFull]: spec.text[textShort] }); }
              catch (err) { sendLog('  text failed: ' + (err as Error).message, 'error'); }
            }
          }
        }
      }

      deferOrApplyWidth(instance, spec.width);
      deferOrApplyHeight(instance, spec.height);

      return instance;
    } catch (err) {
      sendLog('Failed: "' + spec.component + '": ' + (err as Error).message, 'error');
      return null;
    }
  }

  // Frame node (default or explicit type === 'frame')
  var frame = figma.createFrame();
  frame.name = spec.name || 'Frame';
  var layoutDir = spec.layout || 'vertical';
  frame.layoutMode = layoutDir === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  frame.itemSpacing = spec.spacing || 0;
  frame.layoutSizingHorizontal = 'HUG';
  frame.layoutSizingVertical = 'HUG';

  if (spec.padding) {
    frame.paddingTop = spec.padding.top || 0;
    frame.paddingRight = spec.padding.right || 0;
    frame.paddingBottom = spec.padding.bottom || 0;
    frame.paddingLeft = spec.padding.left || 0;
  }

  if (spec.fill) {
    var fillColor = hexToRgb(spec.fill);
    frame.fills = [{ type: 'SOLID', color: fillColor }];
  } else {
    frame.fills = [];
  }

  if (spec.align) {
    var alignVal = ALIGN_MAP[spec.align];
    if (alignVal) frame.primaryAxisAlignItems = alignVal;
  }
  if (spec.counterAlign) {
    var counterVal = COUNTER_ALIGN_MAP[spec.counterAlign];
    if (counterVal) frame.counterAxisAlignItems = counterVal;
  }
  if (spec.cornerRadius) {
    frame.cornerRadius = spec.cornerRadius;
  }

  // Build children
  var childNodes: SceneNode[] = [];
  if (spec.children) {
    for (var ci = 0; ci < spec.children.length; ci++) {
      var childNode = await buildChildNode(spec.children[ci], library);
      if (childNode) {
        frame.appendChild(childNode);
        childNodes.push(childNode);
      }
    }
  }

  // Apply deferred FILL on children now in auto-layout
  applyDeferredFills(childNodes);

  // Defer own FILL, apply others immediately
  deferOrApplyWidth(frame, spec.width);
  deferOrApplyHeight(frame, spec.height);

  return frame;
}

// ── Build variant ────────────────────────────────────────────
async function buildVariant(
  def: VariantDefinition,
  variantName: string,
  library?: string
): Promise<ComponentNode> {
  var comp = figma.createComponent();
  comp.name = variantName;
  comp.layoutMode = def.layout === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  comp.itemSpacing = def.spacing || 0;
  comp.layoutSizingHorizontal = 'HUG';
  comp.layoutSizingVertical = 'HUG';

  if (def.padding) {
    comp.paddingTop = def.padding.top || 0;
    comp.paddingRight = def.padding.right || 0;
    comp.paddingBottom = def.padding.bottom || 0;
    comp.paddingLeft = def.padding.left || 0;
  }

  if (def.fill) {
    var fillColor = hexToRgb(def.fill);
    comp.fills = [{ type: 'SOLID', color: fillColor }];
  } else {
    comp.fills = [];
  }

  if (def.align) {
    var alignVal = ALIGN_MAP[def.align];
    if (alignVal) comp.primaryAxisAlignItems = alignVal;
  }
  if (def.counterAlign) {
    var counterVal = COUNTER_ALIGN_MAP[def.counterAlign];
    if (counterVal) comp.counterAxisAlignItems = counterVal;
  }

  // Build children and track text properties
  var variantChildren: SceneNode[] = [];
  var textPropIndex = 0;
  for (var i = 0; i < def.children.length; i++) {
    var childSpec = def.children[i];
    var childNode = await buildChildNode(childSpec, library);
    if (!childNode) continue;

    comp.appendChild(childNode);
    variantChildren.push(childNode);

    // Expose text nodes marked as properties
    if (childSpec.type === 'text' && childSpec.isProperty && childNode.type === 'TEXT') {
      var propName = childSpec.name || ('Text ' + (textPropIndex + 1));
      var defaultVal = childSpec.content || 'Text';
      try {
        var propKey = comp.addComponentProperty(propName, 'TEXT', defaultVal);
        // Link the text node to the component property
        (childNode as TextNode).componentPropertyReferences = { characters: propKey };
      } catch (err) {
        sendLog('  text property failed: ' + (err as Error).message, 'error');
      }
      textPropIndex++;
    }
  }

  // Apply deferred FILL on children now in auto-layout
  applyDeferredFills(variantChildren);

  // Apply sizing on the component itself
  if (def.width !== undefined) applyWidth(comp, def.width);
  if (def.height !== undefined) applyHeight(comp, def.height);

  return comp;
}

// ── Main entry point ─────────────────────────────────────────
export async function createComponentFromSpec(spec: ComponentSpec): Promise<SceneNode> {
  sendLog('Creating component: ' + spec.name);

  // Load fonts
  await loadFonts(spec.library);
  sendLog('Fonts loaded');

  // Build variant name string from variant record
  function makeVariantName(variant: Record<string, string>): string {
    var parts: string[] = [];
    for (var key in variant) {
      if (variant.hasOwnProperty(key)) {
        parts.push(key + '=' + variant[key]);
      }
    }
    return parts.join(', ');
  }

  // Build all variants
  var components: ComponentNode[] = [];
  for (var di = 0; di < spec.definitions.length; di++) {
    var def = spec.definitions[di];
    var variantName = makeVariantName(def.variant);
    sendLog('  Building variant: ' + variantName);
    var comp = await buildVariant(def, variantName, spec.library);
    components.push(comp);
  }

  // Combine into component set if multiple variants, or return single
  var result: SceneNode;
  if (components.length > 1) {
    var componentSet = figma.combineAsVariants(components, figma.currentPage);
    componentSet.name = spec.name;
    if (spec.description) {
      componentSet.description = spec.description;
    }
    result = componentSet;
    sendLog('Created component set: ' + spec.name + ' with ' + components.length + ' variants');
  } else if (components.length === 1) {
    var singleComp = components[0];
    singleComp.name = spec.name;
    if (spec.description) {
      singleComp.description = spec.description;
    }
    result = singleComp;
    sendLog('Created component: ' + spec.name);
  } else {
    throw new Error('No variant definitions in spec');
  }

  return result;
}
