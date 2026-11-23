# Brand spec · Cubicore · recorded 2026-11-23
source: docs/assets/cubicore-logo.svg, docs/assets/cubicore-mark.svg, docs/assets/cubicore-banner.svg (local assets read directly; no network fetch)
primary: #2e86d6 → oklch(60.8% 0.1467 250.0) (the four inner squares)
pale:    #9bd8f7 → oklch(85.2% 0.0756 230.8) (the ground square)
surface: #ffffff → kept as tinted near-white oklch(98.6% 0.0068 248)
ink:     #000000 → kept as tinted near-black oklch(22% 0.0374 247)
fonts:   Space Grotesk Bold (wordmark outlined to paths in cubicore-banner.svg), IBM Plex Sans body, JetBrains Mono for measured values
logo:    docs/assets/cubicore-logo.svg and docs/assets/cubicore-mark.svg
attestation: derived from the local SVG source above, not from memory

Dark derivation (2026-11-23)
- The recorded brand hex values are facts and are kept as `--color-brand-blue` and `--color-brand-pale`.
- Page accent for dark: `oklch(68% 0.126 250)`, same hue 250, chroma lowered from 0.1467 and lightness raised from 60.8% so the fill does not glare.
- Accent ink for the primary key: `oklch(18% 0.03 250)`, a near-navy drawn from the logo ink.
- Pale blue is used as a field wash only, never as a large background on dark.
- No hue moves between the recorded facts and the derived tokens.
