# Cubicore Landing Page — Build Prompt

> **Copy this entire file and paste it into your coding agent.**
> 
> This prompt builds the **Cubicore landing page** — a static site hosted on **GitHub Pages** (`docs/` folder), styled like `.tools` domains (clean, readable, fast).

---

## Project Overview

**Product**: Cubicore — a virtual company that turns a prompt into validated, parallel, contract-driven work.

**Target Audience**: Developers who want parallel, verified, contract-driven development.

**Vibe**: `.tools` domains — clean, readable, fast, no fluff. Think `regex.tools`, `json.tools`, `cron.tools`.

**Hosting**: GitHub Pages → deploy from `docs/` folder.

---

## Site Structure (Single Page, Anchor Navigation)

```
┌─────────────────────────────────────────────────────────────┐
│  Hero: Name + Tagline + CTA (GitHub / Try It)              │
├─────────────────────────────────────────────────────────────┤
│  What It Is (2-3 sentences + diagram)                       │
├─────────────────────────────────────────────────────────────┤
│  Features (3-4 cards: Parallel, Verified, Contract-Driven)  │
├─────────────────────────────────────────────────────────────┤
│  Live Demo / Example (animated terminal or screenshot)      │
├─────────────────────────────────────────────────────────────┤
│  Quick Start (3 commands)                                   │
├─────────────────────────────────────────────────────────────┤
│  How It Works (4 steps: Plan → Execute → Test → Fix)        │
├─────────────────────────────────────────────────────────────┤
│  Architecture (diagram: Plan → Execute → Test → Fix)        │
├─────────────────────────────────────────────────────────────┤
│  Commands Reference (table)                                 │
├─────────────────────────────────────────────────────────────┤
│  Source Code Link + License                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Visual Style (`.tools` Aesthetic)

| Property | Value |
|----------|-------|
| **Font** | System UI stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`) |
| **Mono Font** | `ui-monospace, SFMono-Regular, 'Fira Code', monospace` |
| **Background** | `#0a0a0a` (near-black) |
| **Surface** | `#111111` / `#1a1a1a` (cards) |
| **Border** | `#2a2a2a` |
| **Text Primary** | `#e8e8e8` |
| **Text Muted** | `#888888` |
| **Accent** | `#00d4aa` (teal) |
| **Accent Hover** | `#00e8bb` |
| **Border Radius** | `8px` (cards), `4px` (buttons) |
| **Spacing Scale** | `4px` base (`4, 8, 16, 24, 32, 48, 64`) |
| **Max Width** | `800px` (content), `1000px` (code blocks) |
| **Transition** | `150ms ease` |

**Code Blocks**: Dark background (`#0d0d0d`), syntax highlighting (Prism or Shiki), copy button.

**Buttons**:
- Primary: `background: #00d4aa; color: #0a0a0a; font-weight: 600;`
- Secondary: `background: transparent; border: 1px solid #2a2a2a; color: #e8e8e8;`
- Ghost: `background: transparent; color: #888;`

**Animations**: Fade-in up on scroll (IntersectionObserver), button hover scale `1.02`, link underline slide.

---

## Content (Copy-Paste Ready)

### Hero
```
Cubicore
A virtual company that turns a prompt into verified, parallel, contract-driven work.

[GitHub] [Try It Live] [Quick Start]
```

### What It Is
> **Cubicore** turns a prompt into a plan, splits it into independent contracts, runs them in parallel with worktree isolation, gates every contract with mechanical checks, and iterates until the `try` block passes.
>
> You get: **parallel execution**, **mechanical verification**, **contract-driven scope**, **automatic fix loops**.

### Features (3 Cards)

| Feature | Description |
|---------|-------------|
| **Parallel by Default** | Contracts with disjoint write scopes run simultaneously. No manual orchestration. |
| **Mechanical Verification** | Every contract has blocking, convergent checks (tests, typecheck, lint). No "looks good" — only pass/fail. |
| **Contract-Driven Scope** | Each worker gets its own write scope, read list, and checks. Collisions caught at plan time, not runtime. |
| **Auto-Fix Loop** | Tests fail → `/cubicore:fix` reads `DEBUG.md` → plans fixes → re-dispatches → re-tests. |

### Quick Start (3 Commands)
```bash
# 1. Install
npm i -g @cubicore/cli

# 2. Plan
cubicore plan "Build a personal expense tracker API with SQLite"

# 3. Execute
cubicore execute
```

### How It Works (4 Steps)

```mermaid
graph LR
  A[Plan] --> B[Execute]
  B --> C[Test]
  C -->|fail| D[Fix]
  D --> B
  C -->|pass| E[Try Block]
  E -->|pass| F[Deploy]
  E -->|fail| D
```

1. **Plan** — `/cubicore:plan` researches the repo, asks clarifying questions, writes `CUBICORE_PLAN.json` with disjoint contracts, checks, and a `try` block.
2. **Execute** — Spawns isolated worktrees per contract, runs them in parallel, gates each with Schema → Verify → Scope.
3. **Test** — Runs all contract checks + `try` block. Failures → `CUBICORE_DEBUG.md`.
3. **Fix** — Reads `DEBUG.md`, plans minimal fixes, re-dispatches only failed contracts. Loop until green.
4. **Deploy** — `/cubicore:deploy` plans hosting, writes configs, explains manual steps.

### Commands Reference

| Command | Purpose |
|---------|---------|
| `cubicore plan "..."` | Research → plan → `CUBICORE_PLAN.json` + `CUBICORE_PLAN.md` |
| `cubicore execute` | Dispatch contracts in parallel, run gates, aggregate |
| `cubicore test` | Run check matrix → `CUBICORE_DEBUG.md` |
| `cubicore fix` | Read `DEBUG.md`, plan fixes, re-dispatch |
| `cubicore try` | Run `try` block, verify it works |
| `cubicore deploy` | Plan hosting, write configs, explain steps |
| `cubicore refine "..."` | Modify plan, re-dispatch changed contracts |
| `cubicore undo` | Revert last execution to baseline |
| `cubicore status` | Poll run status |
| `cubicore estimate` | Token/wall/time estimate before spend |
| `cubicore cancel` | Stop in-flight run |
| `cubicore undo` | Revert last execution to baseline |

### Source & License
```
Source: github.com/your-org/cubicore
License: MIT
```

---

## Technical Requirements

### Stack
- **Framework**: Vanilla HTML/CSS/JS (no framework) — single `index.html`, `style.css`, `app.js`
- **Syntax Highlighting**: Prism.js (lightweight) or Shiki via CDN
- **Icons**: Inline SVG (Lucide or custom)
- **No build step** — open `index.html` directly

### Files to Create
```
docs/
├── index.html          # Main page
├── style.css           # All styles
├── app.js              # Interactions (scroll spy, copy buttons, theme toggle)
├── favicon.svg         # Cubicore logo
└── assets/
    └── diagram.svg     # Architecture diagram (SVG)
```

### GitHub Pages Deploy
1. Push to `main` branch
2. Settings → Pages → Source: `main` branch, `/docs` folder
2. Custom domain (optional): `cubicore.tools` or `cubicore.dev`

---

## Acceptance Criteria

- [ ] Loads in < 1s on 3G (Lighthouse Performance > 90)
- [ ] Lighthouse Accessibility > 95
- [ ] Works without JS (content readable, links work)
- [ ] Dark mode only (no light mode toggle needed)
- [ ] Responsive: 320px → 1440px
- [ ] Code blocks: copy button, line numbers, syntax highlight
- [ ] Smooth scroll to anchors, URL updates
- [ ] Reduced motion respected (`prefers-reduced-motion`)
- [ ] Print stylesheet (clean PDF export)
- [ ] `robots.txt` + `sitemap.xml` generated

---

## Deliverables Checklist

- [ ] `docs/index.html` — semantic HTML5, ARIA labels
- [ ] `docs/style.css` — all styles, no framework
- [ ] `docs/app.js` — scroll spy, copy buttons, smooth scroll, theme respect
- [ ] `docs/assets/diagram.svg` — architecture diagram (inline SVG)
- [ ] `docs/favicon.svg` — Cubicore logo
- [ ] `README.md` in repo root links to live site

---

## Definition of Done

Run this to verify:
```bash
cd docs && npx serve .
# Open http://localhost:3000 — verify all sections render, no console errors
```

---

> **Note to Collaborator**: This is the *entire* spec. Build exactly this. No extra features. Match the `.tools` aesthetic precisely. When done, push to `main` and enable GitHub Pages from `/docs`.

---

*Generated for Cubicore collaborator. Paste into your coding agent and build.*