# Cubicore site design system

Locked 2026-11-23. Cobalt, built from the brand's own logo. Founder instruction on 2026-11-23 replaced the earlier Console system; this file is the current lock.

| Decision | Value |
| --- | --- |
| Mode | Dark only. Light tokens are not shipped; the brand palette is re-derived, not inverted. |
| Brand | Cubicore, spec in `.hallmark/brand-spec.md`, read from `docs/assets/*.svg` |
| Theme | Cobalt, cool near-white paper, blue-grey ink, logo blue signal |
| Brand colours | recorded facts `#2e86d6` and `#9bd8f7` from the logo SVG; dark accent is the same hue 250 with lower chroma and higher lightness so it holds contrast |
| Type | Space Grotesk for heads and the wordmark (from `cubicore-banner.svg`), IBM Plex Sans for body, JetBrains Mono for measured values and code |
| Signal | Blue is the instrument and the action. One blue-to-paper ramp in the hero; a deeper blue keeps text contrast on controls. No purple-blue gradient |
| Surfaces | Dark paper ladder (14.5%, 18%, 21.5% L), hairline rules, cut corners on panels and code. Shadows are dark and offset, never a coloured glow. |
| Dark band | Graphite ground for the integration panel and install band, with its own pale ink |
| Controls | One solid blue keycap with a real bottom edge. Everything else is a rule or a link |
| Container | `--container` 1440px, `--gutter` 64px, 12 columns, `--gap-columns` 32px |
| Hero | Stage on `/`, Banner on `/docs` and `/tutorial` |
| Footer | Mast: wordmark over links and colophon |
| Imagery | None. The run record is the visual |

Shared tokens come from `tokens.css`. Shared Floor rules come from `base.css`. Page composition lives in `styles.css`; page content lives in the HTML files.

A new page keeps these brand colours, faces, signals, corners and chrome. It may change its composition and hero posture. It may not invent a second accent, redraw the mark, or use a gradient with unrelated hues.
