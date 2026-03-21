// DS Assembler — Shared type definitions

// ── Registry types ──────────────────────────────────────────
export interface ComponentEntry {
  key: string;
  library: string;
  variants: Record<string, string[]>;
  variantShortNames: Record<string, string>;
  textProperties: string[];
}

export interface Registry {
  meta: { generatedAt: string; libraries: Record<string, any> };
  components: Record<string, ComponentEntry>;
}

// ── Spec types (layout DSL) ─────────────────────────────────
export interface SpecFrame {
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

export interface SpecInstance {
  component: string;
  props?: Record<string, string>;
  text?: Record<string, string>;
  width?: number | 'hug' | 'fill';
  height?: number | 'hug' | 'fill';
}

export type SpecNode = SpecFrame | SpecInstance;

// ── Analysis output types ───────────────────────────────────
export interface AnalysisResult {
  file: { name: string; key: string };
  scope: 'page' | 'file';
  page: { name: string; id: string };
  instances: InstanceInfo[];
  issues: Issue[];
  stats: AnalysisStats;
}

export interface InstanceInfo {
  nodeId: string;
  name: string;
  componentKey: string;
  componentName: string;
  library: string;
  variants: Record<string, string>;
  textOverrides: Record<string, string>;
  x: number; y: number; width: number; height: number;
}

export interface Issue {
  nodeId: string;
  type: 'hardcoded-color' | 'detached-component' | 'missing-auto-layout' | 'non-library-node' | 'spacing-inconsistency';
  description: string;
  severity: 'error' | 'warning' | 'info';
}

export interface AnalysisStats {
  totalNodes: number;
  instances: number;
  uniqueComponents: number;
  hardcodedColors: number;
  missingAutoLayout: number;
}

// ── Update types ────────────────────────────────────────────
export interface UpdateInstruction {
  nodeId: string;
  action: 'set-variant' | 'set-text' | 'swap-component' | 'replace-with-instance' | 'delete' | 'set-fill' | 'set-auto-layout';
  props?: Record<string, string>;
  text?: Record<string, string>;
  componentName?: string;
  fill?: string;
  layout?: 'vertical' | 'horizontal';
  spacing?: number;
}

export interface UpdatePlan {
  updates: UpdateInstruction[];
}

export interface UpdateResult {
  applied: number;
  failed: number;
  skipped: number;
  errors: { nodeId: string; action: string; error: string }[];
  details: { nodeId: string; action: string; status: 'applied' | 'failed' | 'skipped'; message?: string }[];
  durationMs: number;
}
