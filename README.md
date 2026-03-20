# Actian DS Assembler

Figma plugin that assembles real component instances from published Actian DS2026 and Fat Marker libraries via JSON layout specs.

## Prerequisites

- Figma desktop app
- FM Kit and DS2026 libraries enabled in your Figma team
- Node.js 18+
- A Figma personal access token (for building the registry)

## Setup

### 1. Build the component registry

```bash
FIGMA_TOKEN=figd_xxx node registry/build-registry.js
node registry/build-token-map.js
```

Re-run when library components are added or renamed.

### 2. Build the Figma plugin

```bash
cd plugin && npm install && npm run build
```

### 3. Install in Figma

Plugins → Development → Import plugin from manifest → select `plugin/manifest.json`

## Usage

1. Serve a layout spec JSON on localhost:
   ```bash
   python3 serve.py 8765
   ```
2. In Figma, run **Actian DS Assembler**
3. Enter the spec URL (default: `http://localhost:8765/spec.json`)
4. Click **Assemble**
5. Real component instances appear on your canvas

## Layout Spec Format

See the [design spec](https://github.com/volivarii/Actian-DS-Claude-plugin/blob/main/docs/superpowers/specs/2026-03-20-figma-component-assembler-design.md) for the full JSON schema.

Quick example:
```json
{
  "version": "1.0",
  "name": "My Screen",
  "type": "frame",
  "layout": "vertical",
  "width": 1440,
  "height": 900,
  "children": [
    { "component": "FM App_header", "width": "fill" },
    {
      "type": "frame",
      "layout": "horizontal",
      "width": "fill",
      "height": "fill",
      "children": [
        { "component": "FM Side navigation bar", "height": "fill" },
        {
          "type": "frame",
          "name": "Content",
          "layout": "vertical",
          "spacing": 16,
          "padding": { "top": 24, "right": 24, "bottom": 24, "left": 24 },
          "width": "fill",
          "children": [
            { "component": "FM Button", "props": { "Type": "Primary" } }
          ]
        }
      ]
    }
  ]
}
```

## With Claude

Use `/generate-flow` with "use real components" in the [Actian DS Claude plugin](https://github.com/volivarii/Actian-DS-Claude-plugin). Claude outputs a layout spec JSON and serves it locally.

## Registry Stats

- 1112 components (36 FM Kit, 1076 DS2026)
- 202 design tokens (Actian theme)
