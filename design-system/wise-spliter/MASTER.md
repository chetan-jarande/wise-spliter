# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Wise-Spliter
**Generated:** 2026-11-11 20:45:03
**Category:** Personal Finance Tracker
**Design Dials:** Variance 7/10 (Balanced / Modern) | Motion 6/10 (Standard) | Density 5/10 (Standard)

---

## Global Rules

### Color Palette (Apple visionOS / Ombria Spatial Liquid Glass)

| Role | Dark Mode (Smoked Stone Glass) | Light Mode (Frosted Pearl Glass) | Utility / Token |
|------|--------------------------------|----------------------------------|-----------------|
| Ambient Backdrop | `#171917` + warm sage/stone radial blooms | `#E7EBE8` + sunlit pearl/sage blooms | `.lg-ambient-backdrop` |
| Spatial Glass Shell | `rgba(32,35,32,0.62)` + `blur(28px) saturate(165%)` | `rgba(255,255,255,0.72)` + `blur(28px) saturate(165%)` | `.lg-glass-shell` |
| Double-Bezel Card | `.lg-bezel-outer` + `.lg-bezel-inner` | `.lg-bezel-outer` + `.lg-bezel-inner` | `<DoubleBezelCard />` |
| Scene Action Capsule | `rgba(42,45,42,0.44)` + 1px specular rim | `rgba(255,255,255,0.72)` + 1px specular rim | `.lg-scene-tile` / `<SpatialActionTile />` |
| Luminous Focal Pill | `#F3F4F1` bg / `#141614` ink | `#181B19` bg / `#F7F9F7` ink | `.lg-luminous-pill` |
| Recessed Input Well | `rgba(10,12,11,0.34)` + `rgba(255,255,255,0.09)` border | `rgba(20,26,22,0.045)` + `rgba(20,26,22,0.09)` border | `.lg-recessed-well` |
| Icon Orb | `rgba(255,255,255,0.075)` + specular top rim | `rgba(20,26,22,0.055)` + specular top rim | `.lg-icon-orb` |
| Positive / Owed | `#6EE7B7` / `emerald-300` | `#047857` / `emerald-800` | Semantic positive money |
| Negative / Owe | `#FDA4AF` / `rose-300` | `#BE123C` / `rose-800` | Semantic negative / destructive |

**Color Notes:** Warm architectural smoked-stone glass in dark mode and frosted pearl-alabaster glass in light mode, with luminous high-contrast focal pills and calm desaturated emerald/rose money semantics. Zero neon glows, zero AI-purple gradients, zero cold `#090D16` / `slate-950` blocks.

### Typography

- **Heading & UI Font:** `Plus Jakarta Sans` (Geometric precision grotesk - clean, high-legibility financial hierarchy)
- **Monospace / Financial Numerals Font:** `JetBrains Mono` with `font-variant-numeric: tabular-nums` (Mandatory for all currency amounts, split percentages, exchange rates, and HLC revision IDs)
- **Icon System:** `@phosphor-icons/react` exclusively (single family, consistent stroke/weight; never mix icon libraries or raw emojis)
- **Punctuation Discipline:** Zero em-dashes or en-dashes in UI copy or data; use regular hyphens (`-`) only.
- **Double-Bezel Card Architecture:** Major containers use a nested outer shell (`rounded-[1.5rem] p-1.5 ring-1 ring-slate-900/5 dark:ring-white/10 bg-slate-900/[0.02] dark:bg-white/[0.03]`) wrapping an inner core (`rounded-[calc(1.5rem-0.375rem)] bg-white dark:bg-[#111827] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]`).

### Spacing Variables

*Density: 5/10, Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #059669;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #1E40AF;
  border: 2px solid #1E40AF;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #0F172A;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #1E40AF;
  outline: none;
  box-shadow: 0 0 0 3px #1E40AF20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Glassmorphism

**Keywords:** Frosted glass, transparent, blurred background, layered, vibrant background, light source, depth, multi-layer

**Best For:** Modern SaaS, financial dashboards, high-end corporate, lifestyle apps, modal overlays, navigation

**Key Effects:** Backdrop blur (10-20px), subtle border (1px solid rgba white 0.2), light reflection, Z-depth

### Page Pattern

**Pattern Name:** Product Demo + Features

- **Conversion Strategy:** Use an interactive demo only when it explains value better than static media. Provide captions, transcript, visible play/pause controls, and a non-video fallback; do not autoplay under reduced motion. Pause media when offscreen or hidden and keep the final product state available as static content.
- **CTA Placement:** Video center + CTA right/bottom
- **Section Order:** Hero > Product video/mockup (center) > Feature breakdown per section > Comparison (optional) > CTA

---

## Motion

**Stagger List** (Standard): Trigger: load or scroll | Duration: 300-450ms | Easing: `back.out(1.4)`

```js
gsap.from('.grid-item', { opacity: 0, scale: 0.92, y: 16, duration: 0.4, stagger: { each: 0.06, from: 'start', grid: 'auto' }, ease: 'back.out(1.4)' });
```

**Framework notes:** grid: 'auto' lets GSAP infer rows/columns from a CSS grid layout for a natural wave stagger; Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Combine with from: 'center' for a bento-grid layout to draw the eye inward first
- ❌ Don't use back.out on dense data tables; the overshoot reads as sloppy on informational UI
- ⚡ Group DOM writes; avoid interleaving layout reads (getBoundingClientRect) between staggered tweens

---

## Anti-Patterns (Do NOT Use)

- ❌ Pure white backgrounds

### Additional Forbidden Patterns

- ❌ **Emojis as icons**: Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer**: All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers**: Avoid scale transforms that shift layout
- ❌ **Low contrast text**: Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes**: Always use transitions (150-300ms)
- ❌ **Invisible focus states**: Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
