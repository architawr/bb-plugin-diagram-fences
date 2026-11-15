---
name: diagram-fences
description: "Draw PlantUML, Graphviz/dot, D2 and other diagram fences in BB via the Diagram Fences plugin — where diagrams render, the render modes, and what to do when one fails."
---

# Diagram Fences

The **Diagram Fences** plugin draws fenced diagram blocks that BB itself does
not: `plantuml` (`puml`, `uml`, `c4plantuml`, `c4`), `dot` (`graphviz`, `gv`),
`d2`, and the wider Kroki family (`structurizr`, `excalidraw`, `nomnoml`,
`wavedrom`, `bytefield`, `svgbob`, `dbml`, `bpmn`, `ditaa`, `erd`, `pikchr`,
`wireviz`, `symbolator`, `umlet`, `vega`, `vegalite`, `blockdiag`, `seqdiag`,
`actdiag`, `nwdiag`, `rackdiag`, `packetdiag`).

Mermaid is **not** claimed: BB draws ```` ```mermaid ```` itself.

## Where it draws

- Assistant replies in chat — fenced blocks render as diagrams, with source,
  copy and open-in-tab controls.
- Markdown file previews — the plugin's content script replaces the code block
  with the rendered diagram. Plugin editors and raw source views keep the code.

A block is drawn once the closing fence arrives; while a reply streams, the
code block stays.

## Modes (Settings → plugin → Diagram engines)

- `auto` (default) — a local engine when the machine has one, kroki.io otherwise.
- `local` — only this machine; an unsupported language or a missing engine is
  an error instead of a silent fallback.
- `kroki` — the public kroki.io service.
- `custom` — your own Kroki URL.

Local engines are resolved per engine: a custom path from settings, then a
binary the plugin installed under
`<dataDir>/plugins/diagram-fences/engines/`, then the binary on `PATH`.
Graphviz falls back to a bundled WASM renderer. Settings → Diagram engines has
**Install**, **Use my own binary…**, **Test** and **Remove** for each engine,
and `autoDownload` (on by default) fetches a missing PlantUML (~54 MB) or D2
(~17 MB) build on the first diagram that needs it. Kroki-only languages always
use Kroki.

## Rules for authors

- Fence the diagram, put nothing but the diagram body inside it, and keep the
  language tag exact (`plantuml`, `dot`, `d2`).
- PlantUML: write standard `@startuml … @enduml` bodies. `-darkmode` is applied
  automatically in dark theme, so light-only skinparams may look wrong there.
- Prefer `dot`/`d2` for boxes-and-arrows; a diagram that fails to parse shows
  its error and BB's code block.

## Troubleshooting

- `no local engine draws <language>` — mode is `local`; switch to `auto`/`kroki`
  or install the engine.
- `PlantUML engine is downloading` — the first local PlantUML diagram triggers a
  one-time download; the next render draws.
- `Kroki HTTP 4xx/5xx` — the diagram source is invalid or the public service is
  unavailable; check the body first.
- Settings → Diagram engines lists each engine, its path, and the cache size,
  and offers **Download PlantUML engine** and **Clear cache**.
