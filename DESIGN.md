# Sales Claw Design System

> Japanese version: [docs/ja/DESIGN.md](./docs/ja/DESIGN.md)
>
> Dashboard for automated B2B outreach. A data-dense, professional UI that
> balances operational efficiency with a sense of trust.
> Inspired by: Notion (warm minimalism + 4-layer shadows), Stripe
> (financial-grade precision), Linear (status-driven UI), Vercel
> (shadow-as-border), Superhuman (extreme color restraint).

---

## 1. Visual Theme & Atmosphere

Sales Claw is the "outreach command center". The UI surfaces large volumes of
company data and processing state at a glance. A clean white canvas, deep
slate-blue (`#0f172a`) headings, and a vivid blue (`#2563eb`) accent
combine credibility with a clear call to action.

**Design principles:**
- **Data density × whitespace balance**: tables and status cards stay dense;
  the surrounding UI chrome breathes (Stripe-style).
- **Status-driven**: every color carries meaning. No decorative color.
- **Shadow-as-Border**: Vercel-style `box-shadow: 0 0 0 1px` as the border,
  enabling smooth corners and state transitions.
- **Compact & scannable**: a sales rep should grasp the situation in 3
  seconds.
- **Light-mode optimized**: an easy-on-the-eyes palette for long sessions.

---

## 2. Color Palette & Roles

### Primary
- **Claw Blue** (`#2563eb`): primary CTA, active state, links, selected tab
- **Claw Blue Hover** (`#1d4ed8`): hover state
- **Claw Blue Glow** (`rgba(37,99,235,.12)`): selected row highlight,
  focus-ring background
- **On Primary** (`#ffffff`): text on top of the primary color

### Text — Notion-style warm neutrals (no cold blue-grays)
- **Heading** (`#1a1a1a`): headings, emphasis. A warm near-black (close to
  Notion's `rgba(0,0,0,.95)`).
- **Body** (`#5a5a58`): body text, descriptions, secondary labels. Warm gray.
- **Muted** (`#9a9a96`): captions, placeholders, timestamps. Warm light gray.

### Background (Light Mode) — Notion-style warm white
- **Deep** (`#eeefeb`): the furthest-back surface. Scrollbars, recessed
  regions. Slightly yellowish.
- **Base** (`#f5f5f3`): page background. Notion-style warm white.
- **Surface** (`#fafaf8`): sub-areas inside cards, table headers.
- **Card** (`#ffffff`): cards, modals, frontmost surfaces.
- **Raised** (`#f0f0ee`): hover highlight.

### Status (semantic — no decorative use)
| Token | HEX | Use | Background (dim) |
|-------|-----|-----|------------------|
| Success | `#059669` | submitted, complete | `rgba(5,150,105,.1)` |
| Warning | `#d97706` | awaiting approval, attention needed | `rgba(217,119,6,.1)` |
| Error | `#dc2626` | error, failure | `rgba(220,38,38,.1)` |
| Info | `#7c3aed` | analyzing, in progress | `rgba(124,58,237,.1)` |
| Neutral | `#64748b` | excluded, skipped | `rgba(100,116,139,.1)` |

### Pipeline Status Colors (for charts and badges only)
| Status | Color | Use |
|--------|-------|-----|
| Targets | `#6366f1` (Indigo) | count of targeted companies |
| Has form | `#94a3b8` (Slate) | form URL registered |
| Filled | `#3b82f6` (Blue) | form fill complete |
| Awaiting | `#f59e0b` (Amber) | awaiting human approval |
| Submitted | `#10b981` (Emerald) | sent |
| Error | `#ef4444` (Red) | processing failed |
| Excluded | `#64748b` (Slate) | out of scope |

### Border
- **Subtle** (`rgba(15,23,42,.07)`): table row dividers, lightweight card
  edges.
- **Default** (`rgba(15,23,42,.12)`): standard border, filter bar, inputs.
- **Strong** (`rgba(15,23,42,.22)`): hover, active boundary.

---

## 3. Typography Rules

### Font Family
- **Primary**: `Inter`, system-ui, sans-serif
- **Monospace**: `JetBrains Mono`, `Fira Code`, monospace
- **Icon**: `Material Symbols Outlined` (font-variation-settings: 'FILL' 0,
  'wght' 300)

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Color | Use |
|------|------|--------|-------------|----------------|-------|-----|
| Page Title | 1.15rem | 900 | 1.0 | .02em | `--text-1` | app name |
| Section Label | .6rem | 700 | 1.0 | .07em | `--text-2` | uppercase, section heading |
| Stat Number | 1.6rem | 700 | 1.0 | normal | status color | mono, statistic number |
| Stat Label | .6rem | 600 | 1.2 | .05em | `--text-2` | uppercase, statistic label |
| Table Header | .6rem | 700 | 1.0 | .07em | `--text-2` | uppercase, column header |
| Table Body | .8rem | 400 | 1.5 | normal | `--text-1` | table cell text |
| Body | .875rem | 400 | 1.5 | normal | `--text-1` | standard body |
| Caption | .68rem | 500 | 1.3 | normal | `--text-2` | supplementary text, badge labels |
| Micro | .58rem | 700 | 1.1 | .03em | `--text-3` | version, timestamps |
| Button | .78rem | 700 | 1.0 | .04em | inherit | button text |
| Filter Tab | .7rem | 500 | 1.0 | normal | `--text-2` | filter button |
| Filter Select | .78rem | 400 | 1.0 | normal | `--text-1` | dropdown text |
| Code | .75rem | 500 | 1.4 | normal | inherit | mono, code blocks |

### Principles
- **700-800 is for headings and labels only**. Body is 400. Buttons /
  captions are 500-700.
- **Uppercase is for section labels and table headers only**. Letter-spacing
  must be at least `.05em`.
- **Mono fonts are for numbers and technical info only**: stats, version
  strings, log timestamps.
- **Font sizes range from `.58rem` to `1.6rem`**. Avoid extremely large
  sizes (a dashboard prioritizes density).

---

## 4. Component Stylings

### Buttons

**Primary (CTA)**
- Background: `var(--primary)` → `#2563eb`
- Text: `#ffffff`
- Padding: 6px 16px
- Radius: 20px (pill)
- Shadow: `0 2px 10px rgba(59,130,246,.3)`
- Hover: `var(--primary-dim)` → `#1d4ed8`
- Use: "AI form fill", "Launch AI"

**Danger**
- Background: `#dc2626`
- Text: `#ffffff`
- Padding: 4px 12px
- Radius: 6px
- Use: "Delete selected"

**Ghost / Outlined**
- Background: transparent
- Text: `var(--text-2)`
- Border: `1px solid var(--border-default)`
- Radius: 20px (pill)
- Hover: `var(--bg-raised)` background, `var(--text-1)` text
- Use: filter tab, secondary action

**Filter Tab (Active)**
- Background: `var(--primary)`
- Text: `#ffffff`
- Border: `var(--primary)`
- Shadow: `0 2px 10px rgba(59,130,246,.3)`

### Cards & Panels

**Standard Card** (`.chart-panel`, `.tc`)
- Background: `var(--bg-card)` → `#ffffff`
- Border: `1px solid var(--border-subtle)`
- Radius: 8px
- Shadow: `0 1px 8px rgba(15,23,42,.08)`
- Hover: shadow → `0 4px 20px rgba(15,23,42,.1)`, transform:
  `translateY(-2px)`

**Dark Panel** (progress log header)
- Background: `linear-gradient(135deg, #1e293b 0%, #334155 100%)`
- Text: `#e2e8f0`
- Border-radius: 8px (top only)
- Chip: `rgba(255,255,255,.1)` background, `#94a3b8` text

### Table

**Header Row**
- Background: `var(--bg-surface)` → `#f8f9fd`
- Text: uppercase, `.6rem`, weight 700, `var(--text-2)`
- Border-bottom: `1px solid var(--border-default)`

**Body Row**
- Background: `var(--bg-card)` (odd), `var(--bg-raised)` (even)
- Height: 44px fixed
- Text: `.8rem`, weight 400, `var(--text-1)`
- Hover: `var(--primary-glow)`
- Cursor: pointer (click a row to open the detail modal)
- Overflow: `text-overflow: ellipsis`

**Layout**: `table-layout: fixed` + `colgroup` for column width control.

### Filter Bar
- Container: `var(--bg-surface)` background, `1px solid
  var(--border-default)`, radius 10px
- Fields: `var(--bg-deep)` background, radius 7px, height 30px
- Focus: `border-color: var(--primary)`, `box-shadow: 0 0 0 3px
  rgba(59,130,246,.1)`
- Icon: Material Symbols 14px, `var(--text-3)`

### Toast Notifications
- Success: `rgba(16,185,129,.15)` bg, `var(--success)` text, green border
- Error: `rgba(239,68,68,.15)` bg, `var(--error)` text, red border
- Info: `rgba(59,130,246,.15)` bg, `var(--primary)` text, blue border
- Animation: `slideIn` from the right, auto-dismiss after 3s

### Loading Overlay
- Backdrop: `rgba(0,0,0,.3)`
- Content box: `#fff`, radius 12px, shadow `0 8px 32px rgba(0,0,0,.2)`
- Spinner: `.spin` class, `var(--primary)` border-top
- Text: `.85rem`, `var(--text-1)`, weight 500

### Status Badge
- Radius: 4px
- Font: `.6rem`, weight 600
- Padding: 2px 8px
- Color-coded by status (Success / Warning / Error / Info)

### Thinking Indicator (AI is thinking)
- Spinner: `.think-spin`, 10px, `#818cf8` border-top
- Text: `.76rem`, italic, `#818cf8`
- Background: `rgba(99,102,241,.05)`, left border `rgba(99,102,241,.3)`

---

## 5. Layout Principles

### Spacing Scale
```
Base: 8px
Scale: 2px, 3px, 4px, 6px, 7px, 8px, 9px, 10px, 12px, 14px, 16px, 20px, 24px, 32px
```

### Grid System
- **App Header**: fixed 48px, full width, `backdrop-filter: blur(12px)`
- **Tab Bar**: horizontal tabs below the header, pill-style buttons
- **Analytics Panel**: 3-column grid (`1.1fr 1fr 1.8fr`)
  - Col 1: overall progress + status list
  - Col 2: donut chart
  - Col 3: area chart
- **Content Area**: single column, no `max-width` (full width)
- **Table**: `table-layout: fixed` with explicit `colgroup` widths

### Whitespace Philosophy
- **Between sections**: 12px (compact; reduces scroll)
- **Card padding**: 12-16px
- **Table cell**: `.55rem .75rem` padding
- **Between filter tabs**: 4px gap
- **Between analytics cards**: 10px gap

### Border Radius Scale
| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 4px | badges, status chips |
| `--radius-md` | 8px | cards, table containers, modals |
| `--radius-lg` | 12px | chart panels, large cards |
| `--radius-xl` | 20px | filter tabs (pill) |
| Full Pill | 999px | version badges, header buttons |

---

## 6. Depth & Elevation

| Level | Token | Treatment | Use |
|-------|-------|-----------|-----|
| Flat (L0) | — | no shadow | page background, inline text |
| Ambient (L1) | `--shadow-ambient` | `0 1px 8px rgba(15,23,42,.08)` | standard card, table container |
| Card (L2) | `--shadow-card` | `0 4px 20px rgba(15,23,42,.1)` | card on hover, dropdown |
| Modal (L3) | `--shadow-modal` | `0 24px 60px rgba(15,23,42,.2)` | modal, overlay |
| Header | — | `0 1px 12px rgba(15,23,42,.08)` | sticky header |

### Shadow Philosophy
- Unify on Stripe-style slate-blue shadows (`rgba(15,23,42,...)`) across all
  levels.
- Do not use pure-black shadows (`rgba(0,0,0,...)`).
- On hover, add a slight `translateY(-2px)` along with the shadow for a sense
  of lift.
- `backdrop-filter: blur(12px)` is only for the header.

---

## 7. Do's and Don'ts

### Do
- Use status colors only for their meaning (success / warning / error).
- Use `table-layout: fixed` + `text-overflow: ellipsis` to keep row heights
  consistent.
- Filter tabs use pill radius (20px); active state fills with
  `var(--primary)`.
- Statistic numbers use mono font + status color for legibility.
- Modals close with the ESC key.
- Show a loading overlay during async operations.
- Escape user data with `esc()` (five chars: `& < > " '`).
- Render the CLI Activity log with `textContent` (no `innerHTML`).

### Don't
- Don't use status colors decoratively (the brand color is only
  `--primary`).
- Don't let table rows wrap (`white-space: nowrap` is required).
- Don't use radius ≥ 12px on buttons (except pills).
- Don't use pure black (`#000000`) for text (always `#0f172a` slate blue).
- Don't inject user data directly into `innerHTML`.
- Don't use `font-weight: 800-900` in body copy (heading labels only).
- Don't mix dark-mode palette tokens (stay in light mode).

---

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Compact | <768px | Analytics 1 column, table horizontal scroll |
| Standard | 768-1200px | Analytics 2 columns, table fully visible |
| Wide | >1200px | Analytics 3 columns, generous margins |

### Touch Targets
- Button minimum height: 30px
- Table row height: 44px (tap-friendly)
- Filter field height: 30px
- Tab button padding: 4px 13px

### Collapsing Strategy
- Analytics: 3 cols → 2 cols → 1 col (stack)
- Table: keep fixed layout, scroll horizontally
- Progress log: 2 cols → 1 col
- Filter tabs: `flex-wrap` to wrap

---

## 9. Agent Prompt Guide

### Quick Color Reference
```
Primary CTA:     #2563eb (Claw Blue)
CTA Hover:       #1d4ed8
Background:      #f4f6fb (Base)
Card Surface:    #ffffff
Heading Text:    #0f172a (Slate Blue-Black)
Body Text:       #475569 (Slate)
Muted Text:      #94a3b8
Border:          rgba(15,23,42,.12)
Success:         #059669
Warning:         #d97706
Error:           #dc2626
Info/Processing: #7c3aed
```

### Example Component Prompts

**Status card:**
"White-bg card, 1px solid rgba(15,23,42,.07) border, 8px radius. 3px-wide
status color bar on the left. Right-aligned mono `.85rem` bold number.
Label is `.68rem` `#475569`. On hover, shadow `0 4px 20px
rgba(15,23,42,.1)` + `translateY(-2px)`."

**Filter bar:**
"`#f8f9fd` background, 1px solid rgba(15,23,42,.12) border, 10px radius,
7px 10px padding. Inner filter fields are `#f0f2f8` background, 7px radius,
30px tall, with a 14px Material Symbols icon. Focus state is a blue ring:
`0 0 0 3px rgba(59,130,246,.1)`."

**Table row:**
"`table-layout: fixed`. Header is `#f8f9fd` bg, `.6rem` uppercase bold
`#475569`, `letter-spacing: .07em`. Rows are 44px fixed height, odd `#fff`,
even `#eef0f6`. Hover background `rgba(37,99,235,.12)`. `text-overflow:
ellipsis`. Clicking a row opens the detail modal."

**Dark header bar:**
"`linear-gradient(135deg, #1e293b, #334155)` background. Text `#e2e8f0`
`.68rem` bold uppercase `letter-spacing: .1em`. Right-side chip:
`rgba(255,255,255,.1)` bg, `#94a3b8` text, 4px radius. While thinking, show
a spinner + `#818cf8` text."

**Primary button:**
"`#2563eb` background, `#fff` text, `.78rem` bold, `letter-spacing: .04em`,
`6px 16px` padding, 20px radius (pill). `box-shadow: 0 2px 10px
rgba(59,130,246,.3)`. Hover `#1d4ed8`."

### Iteration Guide
1. Always reference colors through CSS variables (`var(--primary)`); never
   hardcode.
2. Always pipe text through `esc()` before rendering; never insert user data
   directly into `innerHTML`.
3. Wrap async operations with `safeFetch()` to auto-show a loading state and
   error toast.
4. Tables use `table-layout: fixed` + `colgroup` for column widths; row
   height stays at 44px.
5. Modals / overlays close on ESC. `z-index: 9999`.
6. Status colors are tied to meaning; never decorative.
7. Shadows use the slate-blue family (`rgba(15,23,42,...)`) consistently —
   pure black is forbidden.
8. The radius scale has 4 steps: `--radius-sm(4)`, `--radius-md(8)`,
   `--radius-lg(12)`, `--radius-xl(20)`.
