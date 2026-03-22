# Review Tab — Merge Analyze + Update

**Date:** 2026-03-23
**Status:** Approved
**Author:** Vincent + Claude

## Problem

The plugin has 4 tabs: Assemble, Analyze, Update, Create. Analyze and Update are a disconnected 2-step workflow that requires leaving Figma to process `analysis.json` externally and write `updates.json` before coming back to apply fixes. This breaks the designer's flow.

## Solution

Replace Analyze and Update tabs with a single **Review** tab. Three-step flow within the tab:

1. **Scan** — analyzes the current page or file
2. **Review** — shows all issues with full detail so the designer can review
3. **Apply** — fetches fixes from server, lets designer select which to apply

Tab structure: **Assemble · Review · Create** (3 tabs, down from 4).

## Design Decisions

- **Fix generation stays on the server** — the plugin posts `analysis.json`, the server/Claude generates `updates.json`. Keeps the plugin thin and fix logic updatable without rebuilding.
- **Two-click flow** — after scan, user sees all issues and clicks "Get fixes" to fetch from server. Not automatic polling — gives the server time to process and the designer time to review issues first.
- **Full issue list visible** — not just a count. Each issue shows severity icon, description, affected node name, and suggested fix. Designer reviews deeply before applying.
- **Selective apply** — fixes shown as a checklist. Designer selects/deselects which to apply. Non-fixable issues (manual) shown greyed out.
- **Back navigation** — "← Back to issues" from the fixes view returns to the issue list.

## UI States

### State 1: Initial (no scan yet)

- Scope picker: "Current page" (default) / "Entire file" radio
- **[Scan]** button (primary)

### State 2: Scanning

- Progress bar with node count: "Scanning: 92/142 nodes"
- **[Cancel]** button replaces Scan

### State 3: Scan complete — Issue list

Summary bar:
```
142 nodes · 23 instances · 8 unique components    5 issues
```

Issue list (scrollable, all issues visible):
```
⚠ Hardcoded fill #2D3648
  Frame "Card header" — should use --zen-color-theme-primary

⚠ Hardcoded fill #CBD2E0
  Frame "Divider" — should use --zen-color-border-default

⚠ Hardcoded fill #EDF0F7
  Frame "Sidebar active" — should use --zen-color-interactive-selected-secondary

ℹ Missing auto-layout
  Frame "Actions" — 4 children, no auto-layout applied

ℹ Missing auto-layout
  Frame "Header row" — 3 children, no auto-layout applied
```

Actions:
- **[Get fixes]** button (primary) — fetches `updates.json` from server
- **[Re-scan]** button (secondary) — resets and re-analyzes

### State 4: Fixes loaded — Select and apply

Back link: "← Back to issues"

Summary:
```
3 fixes available    2 issues need manual fix
```

Fix checklist (all selected by default):
```
☑ Set fill → theme-primary
  Frame "Card header" · replace #2D3648

☑ Set fill → border-default
  Frame "Divider" · replace #CBD2E0

☑ Set fill → interactive-selected-secondary
  Frame "Sidebar active" · replace #EDF0F7
```

Actions:
- **[Apply N fixes]** button (primary) — count updates with selection
- Button label dynamically reflects selection: "Apply 3 fixes" / "Apply 1 fix"

### State 5: Applied

Success bar:
```
✓ 3 applied · 0 failed · 2 skipped (manual)
```

Actions:
- **[Re-scan]** to verify fixes took effect
- **[Done]** resets to State 1

## Issue Types

| Icon | Type | Severity | Auto-fixable |
|------|------|----------|-------------|
| ⚠ | Hardcoded color | warning | Yes — map hex → token via token-map.json |
| ⚠ | Wrong component variant | warning | Yes — set correct variant props |
| ⚠ | Detached instance | warning | Yes — swap to library component |
| ℹ | Missing auto-layout | info | No — requires manual layout decision |
| ℹ | Non-standard naming | info | No — naming is contextual |

## Data Flow

```
Plugin                          Server (localhost:8765)
──────                          ──────────────────────
1. Scan page
   └→ POST /analysis            → saves analysis.json
      (full node tree,
       instances, issues)

2. "Get fixes" clicked
   └→ GET /updates.json         ← server/Claude reads analysis.json,
      (fix instructions)           generates updates.json

3. "Apply" clicked
   └→ applies fixes in Figma
   └→ POST /update-result       → saves update-result.json
      (results summary)
```

## Server Contract

**POST /analysis** — same as current. Plugin sends full analysis result.

**GET /updates.json** — same format as current. Array of update instructions:
```json
{
  "updates": [
    {
      "action": "set-fill",
      "nodeId": "123:456",
      "fill": "--zen-color-theme-primary",
      "description": "Replace hardcoded #2D3648 with theme-primary"
    },
    {
      "action": "set-variant",
      "nodeId": "123:789",
      "props": { "Type": "Primary" },
      "description": "Fix button variant"
    }
  ]
}
```

**POST /update-result** — same as current. Plugin sends results after applying.

## Implementation Scope

### Plugin changes (ui.html + code.ts)
- Remove Analyze tab and Update tab
- Add Review tab with 5 states (initial, scanning, issues, fixes, applied)
- Keep all existing analyzer logic (`analyzeScope`) — just rewire the UI
- Keep all existing updater logic (`applyUpdates`) — just rewire the UI
- No changes to `code.ts` logic — only UI routing

### Server changes (serve.py)
- None. Endpoints unchanged.

### What stays the same
- Assemble tab — unchanged
- Create tab — unchanged
- Registry loading — unchanged
- All `code.ts` analysis and update functions — unchanged
- Server endpoints — unchanged

## Out of Scope
- Auto-generating fixes in the plugin (deferred — server handles this)
- Auto-polling for updates.json (user clicks "Get fixes" explicitly)
- Undo/rollback after applying fixes
