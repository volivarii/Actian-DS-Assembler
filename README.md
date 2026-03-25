# DS Assembler

Figma plugin that assembles real component instances from any published design system library via JSON layout specs. Also serves as the **single source of truth** for all Figma-derived data (component registry, tokens, reference docs, per-component guidelines).

## Features

**Assemble** — Build screens from JSON layout specs
- Real, editable component instances linked to your design system
- Variant and text property overrides
- Auto-layout frames with fill/hug sizing, alignment, padding, spacing
- Token-based fill colors (resolved from a token map)

**Analyze** — Scan a Figma page or file
- Detects all component instances with variants and text overrides
- Flags hardcoded colors (not bound to variables)
- Flags frames missing auto-layout
- Exports results as JSON for AI-powered auditing

**Update** — Apply targeted fixes
- Change variant properties on existing instances
- Swap components, replace non-library nodes with instances
- Fix hardcoded colors, add auto-layout
- Single Cmd+Z undoes all changes

**Create** — Build new components from JSON specs
- Component sets with variants
- Text and boolean properties
- Nested component instances
- Auto-layout with token-based styling

**Performance**
- Component import caching (same key imported only once)
- Non-blocking (yields to main thread to prevent freezing)
- Progress bar with cancel support on all operations

## Data architecture

This repo is the canonical source for all Figma-derived data. The [Claude plugin](https://github.com/volivarii/Actian-DS-Claude-plugin) fetches from here.

```
Figma libraries
    ↓ npm run sync (Figma REST API)
This repo:
    registry/component-registry.json    ← component names, variants, properties
    registry/token-map.json             ← --zen-* token → hex lookup
    registry/ds2026-component-reference.md
    registry/fm-component-catalog.md
    tokens/tokens.css                   ← CSS custom properties
    tokens/actian-ds.tokens.json        ← W3C DTCG format
    docs/design-system.md              ← human-readable token reference
    docs/component-guidelines/*.json    ← per-component content/design guidelines
    ↓
Claude plugin: scripts/sync-from-upstream.sh (fetches via GitHub raw URLs)
```

### What lives where

| Data | Path in this repo | Consumed by |
|------|-------------------|-------------|
| Component registry (12K+ lines) | `registry/component-registry.json` | Assembler plugin (runtime) |
| Token-to-hex map | `registry/token-map.json` | Assembler plugin (runtime) |
| DS2026 component reference | `registry/ds2026-component-reference.md` | Claude plugin (synced) |
| FM Kit component catalog | `registry/fm-component-catalog.md` | Claude plugin (synced) |
| CSS custom properties | `tokens/tokens.css` | Both (synced to Claude plugin) |
| W3C DTCG tokens | `tokens/actian-ds.tokens.json` | Claude plugin (synced) |
| Token reference (human-readable) | `docs/design-system.md` | Claude plugin (synced) |
| Per-component guidelines | `docs/component-guidelines/*.json` | Claude plugin (synced) |
| FM descriptions (manual) | `registry/fm-descriptions.json` | Sync script (fallback for FM) |

## Setup

### 1. Sync the component registry from Figma

```bash
npm run sync                # sync both DS2026 + FM Kit
npm run sync:ds             # DS2026 only
npm run sync:fm             # FM Kit only
```

Requires `FIGMA_TOKEN` in `.env` (see `.env.example`).

This generates:
- `registry/component-registry.json` — all components, variants, properties
- `registry/token-map.json` — token name → hex value
- `registry/ds2026-component-reference.md` — human-readable DS2026 catalog
- `registry/fm-component-catalog.md` — human-readable FM Kit catalog

### 2. Build the Figma plugin

```bash
cd plugin && npm install && npm run build
```

### 3. Install in Figma

Plugins → Development → Import plugin from manifest → select `plugin/manifest.json`

## Usage

### Assemble

1. Serve the project directory:
   ```bash
   python3 serve.py 8765
   ```
2. In Figma, run **DS Assembler**
3. Click **Load Registry** (fetches from `localhost:8765/registry/`)
4. Enter a spec file name (e.g. `spec.json`)
5. Click **Assemble**

### Analyze

1. Open DS Assembler → **Analyze** tab
2. Select scope: "Current page" or "Entire file"
3. Click **Analyze**
4. Results are POSTed to `localhost:8765/analysis` and saved as `analysis.json`

### Update

1. Place an `updates.json` file in the project root
2. Open DS Assembler → **Update** tab
3. Click **Load Updates** → review the list
4. Click **Apply Updates**
5. Cmd+Z undoes all changes at once

### Create

1. Place a `component-spec.json` in the project root
2. Open DS Assembler → **Create** tab
3. Enter the spec filename → click **Create Component**
4. Publish to library when ready

## Syncing guidelines from Figma

Per-component guidelines (content guidelines, design guidelines, screenshots, etc.) are extracted from Figma using the Claude plugin's `/sync-guidelines` skill, then stored here.

To update after the content designer edits guidelines in Figma:

```bash
# 1. Run /sync-guidelines in Claude Desktop or Claude Code
#    (extracts from Figma → writes JSON files)

# 2. Copy the extracted files here
cp -r <extraction-output>/docs/component-guidelines/*.json docs/component-guidelines/

# 3. Commit and push
git add docs/component-guidelines/ && git commit -m "chore: sync component guidelines" && git push
```

The Claude plugin then fetches the updated files via `sync-from-upstream.sh`.

### Coverage

44 components extracted. Per-component frames:

| Frame | Always present | Content |
|-------|:-:|---|
| `Content guidelines` | Yes | Copy rules, terminology, do/don't examples |
| `Components` | Yes | Variant state grid |
| `ready made examples` | Yes | Pre-built usage patterns |
| `design guidelines` | Most | Visual rules, spacing, layout |
| `Screenshots of use cases` | Some | Real product screenshots |
| `Behavior demo` | Some | Interaction/animation docs |

## Layout spec format

```json
{
  "version": "1.0",
  "name": "My Screen",
  "type": "frame",
  "layout": "vertical",
  "width": 1440,
  "height": 900,
  "children": [
    { "component": "My Header", "width": "fill" },
    {
      "type": "frame",
      "layout": "horizontal",
      "width": "fill",
      "height": "fill",
      "children": [
        { "component": "My Sidebar", "height": "fill" },
        {
          "type": "frame",
          "name": "Content",
          "layout": "vertical",
          "spacing": 16,
          "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 },
          "width": "fill",
          "children": [
            { "component": "My Button", "props": { "Type": "Primary" }, "text": { "Label": "Save" } }
          ]
        }
      ]
    }
  ]
}
```

## Supported update actions

| Action | Description |
|--------|-------------|
| `set-variant` | Change variant properties on an instance |
| `set-text` | Change text overrides on an instance |
| `swap-component` | Swap an instance to a different component |
| `replace-with-instance` | Replace a non-instance node with a library instance |
| `delete` | Remove a node |
| `set-fill` | Change fill color |
| `set-auto-layout` | Convert a frame to auto-layout |

## Server endpoints

`serve.py` provides:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/registry/component-registry.json` | Component registry |
| GET | `/registry/token-map.json` | Token-to-hex map |
| GET | `/spec.json` | Layout spec for assembly |
| GET | `/updates.json` | Update instructions |
| POST | `/analysis` | Save analysis results |
| POST | `/update-result` | Save update results |

## Registry format

```json
{
  "meta": { "generatedAt": "...", "libraries": { ... } },
  "components": {
    "My Button": {
      "key": "abc123...",
      "library": "my-lib",
      "variants": { "Type": ["Primary", "Secondary"] },
      "variantShortNames": { "Type": "Type" },
      "textProperties": ["Label#1:2"]
    }
  }
}
```

## Figma libraries

| Library | File key | Components |
|---------|----------|------------|
| [Actian Design System 2026](https://www.figma.com/design/l8biHxfarNi1I2RMvVxVOK) | `l8biHxfarNi1I2RMvVxVOK` | 77 component sets, 728 components |
| [Fat Marker Kit](https://www.figma.com/design/X2JSEUyLvxyNCx22ucOexn) | `X2JSEUyLvxyNCx22ucOexn` | 29 component sets, 391 components |
