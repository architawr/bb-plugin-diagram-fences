# Diagram Fences

Draws the diagram fences BB does not: **PlantUML**, **Graphviz/dot**, **D2**,
and the wider Kroki family — in assistant replies and in Markdown file
previews, with a local engine when this machine has one and kroki.io
otherwise.

Mermaid is not claimed; BB already draws it.

## What you get

- ```` ```plantuml ```` (also `puml`, `uml`, `c4plantuml`, `c4`), ```` ```dot ````
  (`graphviz`, `gv`), ```` ```d2 ````, plus `structurizr`, `excalidraw`,
  `nomnoml`, `wavedrom`, `bytefield`, `svgbob`, `dbml`, `bpmn`, `ditaa`, `erd`,
  `pikchr`, `wireviz`, `symbolator`, `umlet`, `vega`, `vegalite`, `blockdiag`,
  `seqdiag`, `actdiag`, `nwdiag`, `rackdiag`, `packetdiag`.
- Each diagram carries the fence language and the engine that drew it, a source
  toggle, copy, and open-in-a-new-tab.
- In a Markdown file preview the code block is replaced by the diagram (the
  code-fence slot does not reach previews, so a content script does it).
- A broken diagram shows the error and BB's own code block; nothing is hidden.

## Modes

Settings → Installed plugins → Diagram Fences → **Diagram engines**.

| Mode | What it does |
| --- | --- |
| `auto` (default) | A local engine when available, kroki.io otherwise |
| `local` | Only this machine; a missing engine is an error, not a fallback |
| `kroki` | The public kroki.io service |
| `custom` | Your own Kroki URL (`Kroki URL` setting) |

## Local engines

| Engine | How | Cost |
| --- | --- | --- |
| Graphviz | `dot` when installed, otherwise the bundled `@viz-js/viz` WASM | ~30 ms, no process |
| PlantUML | `plantuml` on `PATH`, otherwise a native (GraalVM) binary downloaded once to `<dataDir>/plugins/diagram-fences/engines/` | ~54 MB download, ~0.2 s per diagram, no Java needed |
| D2 | `d2` when installed on `PATH` | per-diagram process |

Nothing stays resident: WASM is created on first use, PlantUML and D2 are
short-lived processes that exit after one render, and every SVG is cached by a
hash of (language, theme, source) in the plugin's SQLite database, so the same
diagram is drawn once per machine. The cache is trimmed to the configured
entry count (400 by default).

## Security

- SVG from Kroki or a local engine is shown through an `<img>` with a blob URL,
  so scripts inside a diagram cannot run in the bb page.
- Files are only written under the plugin's own data directory.
- The HTTP route used by the preview content script is `auth: "local"`: a BB
  app origin only, JSON only.
- Diagram sources are sent to kroki.io only in `auto` (when no local engine
  applies), `kroki`, and `custom` modes. `local` never leaves the machine.

## Limits

- A fence is drawn once its closing fence arrives; during streaming BB's code
  block stays.
- Diagram source is capped by the `maxSourceKb` setting (64 KB default).
- The public kroki.io service is free but has no SLA; use `custom` with a
  self-hosted Kroki for private diagrams or production use.
- PlantUML `!include <C4/...>` and remote `!include` fetch over the network;
  offline machines should keep those diagrams on kroki.io or vendor the
  includes.

## Develop

```sh
cd ~/Development/OpenSource/bb-plugins/bb-plugin-diagram-fences
npm install
bb plugin build
bb plugin install . --yes
bb plugin rpc call diagram-fences status
```

`bb plugin dev` rebuilds and reloads on save.
