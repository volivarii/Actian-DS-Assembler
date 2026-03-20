import componentRegistry from '../../registry/component-registry.json';
import tokenMap from '../../registry/token-map.json';

interface ComponentEntry {
  key: string;
  library: string;
  variants: Record<string, string[]>;
  variantShortNames: Record<string, string>;
  textProperties: string[];
}

interface Registry {
  meta: { generatedAt: string; libraries: Record<string, { fileKey: string; name: string }> };
  components: Record<string, ComponentEntry>;
}

const registry = componentRegistry as unknown as Registry;
const tokens = tokenMap as Record<string, string>;

export function lookupComponent(name: string): ComponentEntry | null {
  return registry.components[name] || null;
}

export function resolveVariantProps(
  entry: ComponentEntry,
  shortProps: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [shortName, value] of Object.entries(shortProps)) {
    const fullName = entry.variantShortNames[shortName];
    if (fullName) {
      resolved[fullName] = value;
    }
  }
  return resolved;
}

export function resolveTextProps(
  entry: ComponentEntry,
  shortText: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [shortName, value] of Object.entries(shortText)) {
    const fullName = entry.textProperties.find(tp => tp.split('#')[0] === shortName);
    if (fullName) {
      resolved[fullName] = value;
    }
  }
  return resolved;
}

export function resolveColor(value: string): RGB | null {
  if (value.startsWith('#')) return hexToRgb(value);
  const hex = tokens[value];
  if (hex) return hexToRgb(hex);
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

export function hasVariants(entry: ComponentEntry): boolean {
  return Object.keys(entry.variants).length > 0;
}

export function getRegistryStats(): { total: number; fatMarker: number; ds2026: number } {
  let fatMarker = 0;
  let ds2026 = 0;
  for (const entry of Object.values(registry.components)) {
    if (entry.library === 'fat-marker') fatMarker++;
    else ds2026++;
  }
  return { total: fatMarker + ds2026, fatMarker, ds2026 };
}
