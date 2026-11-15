## What it is

BB draws Mermaid in chat and in Markdown previews, and nothing else. Diagram
Fences adds the rest of the toolchain developers actually use: PlantUML,
Graphviz, D2 and the wider Kroki family, as fenced code blocks that render where
you read them.

## Where it renders

- Assistant replies: a ```` ```plantuml ````, ```` ```dot ```` or ```` ```d2 ````
  block becomes a diagram with a source toggle, copy, and open-in-tab controls.
- Markdown file previews: the same blocks draw in the right panel, where BB's
  code-fence slot does not reach. A content script swaps the code block for the
  diagram and leaves the file untouched.

## Local first

Drawing does not have to leave the machine, and nothing has to be started:

- Graphviz uses `dot` when it is installed and falls back to a bundled WASM
  build, so boxes-and-arrows always work offline.
- PlantUML uses the official native binary — no Java, no server. The plugin
  downloads it once (~54 MB) the first time a PlantUML fence needs it, and
  renders in about 0.2 s after that.
- D2 uses the `d2` binary when it is on `PATH`.
- Everything else goes to Kroki, public or your own instance.

Each engine runs per diagram and exits. Diagrams are cached by content hash, so
switching threads, reloading, or opening the same file again costs nothing.

## Modes

`Auto` (default) picks a local engine when one exists and kroki.io otherwise.
`Local only` refuses to leave the machine. `kroki.io` and `Own Kroki URL` cover
the hosted cases, including a self-hosted Kroki for private diagrams.

## Safety

Rendered SVG is shown through an `<img>` blob, so a diagram cannot run script in
the bb page. Local files are written only inside the plugin's own data
directory. The preview route accepts BB app origins with JSON bodies only.
