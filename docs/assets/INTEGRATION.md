# qkt-insights brand assets — integration guide

Sibling project to [qkt](https://github.com/elitekaycy/qkt). Same bracket frame,
same colors, same monoline letterforms — `[qkt]/insights` reads as a path,
making the relationship obvious at a glance.

## Files

| File | Use |
|---|---|
| `qkt-insights-logo-dark.svg` | Wordmark for dark backgrounds |
| `qkt-insights-logo-light.svg` | Wordmark for light backgrounds |
| `qkt-insights-mark-dark.svg` | Square `[i]` mark, dark variant — Dokka header, tight spaces |
| `qkt-insights-mark-light.svg` | Square `[i]` mark, light variant |
| `favicon.svg` | Adaptive favicon — auto-switches via `prefers-color-scheme` |
| `favicon.ico` | Multi-resolution `.ico` fallback |
| `favicon-16.png`, `favicon-32.png` | Raw PNG favicons |
| `apple-touch-icon.png` | 180×180 iOS home-screen icon |
| `og-image.png` | 1280×640 social preview card |
| `og-image.svg` | Vector source — edit the tagline here if needed |

## Brand relationship

The `[qkt]` part of the wordmark is **identical** to the `qkt` parent brand —
same brackets, same letters, same colors, same metrics. The slash and `insights`
add the sub-identity. If `qkt` ever changes (e.g. a new bracket color), keep
`qkt-insights` in lockstep by porting the change.

The square mark uses `[i]` where `qkt`'s mark uses `[k]` — same frame, different
center letter. At favicon size (16×16), the two are still distinguishable.

## Suggested repo layout

```
qkt-insights/
├── docs/
│   └── assets/
│       ├── qkt-insights-logo-dark.svg
│       ├── qkt-insights-logo-light.svg
│       ├── qkt-insights-mark-dark.svg
│       ├── qkt-insights-mark-light.svg
│       ├── logo-icon.svg          ← copy of qkt-insights-mark-dark.svg for Dokka
│       ├── favicon.svg
│       ├── favicon.ico
│       ├── apple-touch-icon.png
│       └── og-image.png
└── README.md
```

## 1 · README hero

```markdown
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/qkt-insights-logo-dark.svg">
    <img alt="qkt-insights" src="docs/assets/qkt-insights-logo-light.svg" width="380">
  </picture>
</p>
```

Wordmark is roughly 3.6:1 (wider than `qkt`'s 3:1 because of `insights`), so
`width="380"` gives ~106px tall. Adjust to taste.

Consider opening the README with a one-liner that names the sibling
relationship — e.g. `> Live dashboard for [qkt](https://github.com/elitekaycy/qkt).` —
so readers landing here cold know what `qkt` is.

## 2 · Dokka — replace the default logo

Same setup as `qkt`'s. In `qkt-insights`'s `build.gradle.kts`:

```kotlin
import org.jetbrains.dokka.base.DokkaBase
import org.jetbrains.dokka.base.DokkaBaseConfiguration

plugins {
    id("org.jetbrains.dokka") version "1.9.20"
}

buildscript {
    dependencies {
        classpath("org.jetbrains.dokka:dokka-base:1.9.20")
    }
}

tasks.dokkaHtml.configure {
    pluginConfiguration<DokkaBase, DokkaBaseConfiguration> {
        customAssets = listOf(
            rootProject.file("docs/assets/logo-icon.svg"),
        )
        footerMessage = "© qkt-insights · Apache 2.0"
    }
}
```

The `logo-icon.svg` file should be a copy of `qkt-insights-mark-dark.svg` (or a
symlink). The square `[i]` mark fits Dokka's header logo slot.

## 3 · Docs site `<head>`

```html
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">

<meta property="og:type" content="website">
<meta property="og:title" content="qkt-insights — live dashboard for qkt">
<meta property="og:description" content="Real-time view into qkt strategies, fills, equity, and risk state.">
<meta property="og:image" content="https://elitekaycy.github.io/qkt-insights/assets/og-image.png">
<meta property="og:url" content="https://elitekaycy.github.io/qkt-insights/">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://elitekaycy.github.io/qkt-insights/assets/og-image.png">
```

## 4 · Cross-linking on the README

Since people will arrive at `qkt-insights` looking for `qkt` (and vice versa),
add reciprocal links near the top of each README:

In `qkt-insights/README.md`:
```markdown
> Live dashboard for [qkt](https://github.com/elitekaycy/qkt). Sibling project — same brand, same code style.
```

In `qkt/README.md`, somewhere in the features list or a "related" section:
```markdown
- **Dashboard**: [qkt-insights](https://github.com/elitekaycy/qkt-insights) — real-time view into live strategies.
```

## 5 · Brand spec (matches qkt)

| Token | Value |
|---|---|
| Bracket color (dark bg) | `#a78bfa` |
| Bracket color (light bg) | `#7c3aed` |
| Letter color (dark bg) | `#e5e7eb` |
| Letter color (light bg) | `#0d1117` |
| Slash separator (dark bg) | `#6b7280` |
| Slash separator (light bg) | `#9ca3af` |
| Background (dark) | `#0d1117` |
| Background (light) | `#f6f8fa` |
| Cap height | 100 units |
| Stroke width | 14 units |
| Bracket serif length | 22 units |
| Sub-label font | system monospace stack at `font-size: 120`, `font-weight: 600` |

## Notes on the `insights` text

In the wordmark, `[qkt]/` is hand-drawn paths (zero font dependency); `insights`
is rendered as an SVG `<text>` element using the user's monospace font stack
(JetBrains Mono → SF Mono → Cascadia Code → DejaVu Sans Mono). This is a
deliberate tradeoff:

- **Pro**: file is tiny, easy to edit, looks at home on a dev's machine
- **Con**: `insights` will render slightly differently across OSes

If you want 100% identical rendering everywhere, open the SVG in Inkscape or
Figma and convert the text to paths (`Path → Object to Path` in Inkscape).
