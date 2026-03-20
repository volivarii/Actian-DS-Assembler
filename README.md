# DS Assembler

Figma plugin that assembles real component instances from any published design system library via JSON layout specs.

Works with any Figma component library — bring your own registry.

## Features

- Assembles real, editable component instances linked to your design system
- Variant and text property overrides
- Auto-layout frames with fill/hug sizing, alignment, padding, spacing
- Token-based fill colors (resolved from a token map)
- Progress bar with cancel support
- Component import caching (only imports each unique component once)
- Non-blocking assembly (yields to main thread to prevent freezing)

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
