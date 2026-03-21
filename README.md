# DS Assembler

Figma plugin that assembles real component instances from any published design system library via JSON layout specs.

Works with any Figma component library — bring your own registry.

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

**Performance**
- Component import caching (same key imported only once)
- Non-blocking (yields to main thread to prevent freezing)
- Progress bar with cancel support on all operations

## How it works

1. **Build a component registry** — query the Figma REST API for your library's component keys and variants
2. **Serve the registry + a layout spec** on localhost
3. **Run the plugin** — it loads the registry, then assembles real instances from the spec

## Setup

### 1. Build the component registry

```bash
FIGMA_TOKEN=figd_xxx node registry/build-registry.js
node registry/build-token-map.js
```

### 2. Build the Figma plugin

```bash
cd plugin && npm install && npm run build
```

### 3. Install in Figma

Plugins → Development → Import plugin from manifest → select `plugin/manifest.json`

## Usage

1. Serve the project directory:
   ```bash
   python3 serve.py 8765
   ```
2. In Figma, run **DS Assembler**
3. Click **Load Registry** (fetches from `localhost:8765/registry/`)
4. Enter a spec file name (e.g. `spec.json`)
5. Click **Assemble**

## Layout Spec Format

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

## Analyze

Scan a Figma page or file for component usage, hardcoded colors, and structural issues.

1. Open DS Assembler → **Analyze** tab
2. Select scope: "Current page" or "Entire file"
3. Click **Analyze**
4. Results are POSTed to `localhost:8765/analysis` and saved as `analysis.json`

Use the analysis data with AI tools to generate audit reports and fix instructions.

## Update

Apply targeted fixes to a Figma file based on update instructions.

1. Place an `updates.json` file in the project root with fix instructions
2. Open DS Assembler → **Update** tab
3. Click **Load Updates** → review the list
4. Click **Apply Updates**
5. Cmd+Z undoes all changes at once

### Supported update actions

| Action | Description |
|--------|-------------|
| `set-variant` | Change variant properties on an instance |
| `set-text` | Change text overrides on an instance |
| `swap-component` | Swap an instance to a different component |
| `replace-with-instance` | Replace a non-instance node with a library instance |
| `delete` | Remove a node |
| `set-fill` | Change fill color |
| `set-auto-layout` | Convert a frame to auto-layout |

## Registry Format

The registry maps component names to Figma component keys:

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

## Server Endpoints

`serve.py` provides:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/registry/component-registry.json` | Component registry |
| GET | `/registry/token-map.json` | Token-to-hex map |
| GET | `/spec.json` | Layout spec for assembly |
| GET | `/updates.json` | Update instructions |
| POST | `/analysis` | Save analysis results |
| POST | `/update-result` | Save update results |
