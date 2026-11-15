# Changelog

## 0.2.1 — 2026-11-15

- Marketplace release. The overview now describes per-engine install and custom
  paths, the two-process cap, and D2 installed from settings.

## 0.2.0 — 2026-11-15

- Settings screen rebuilt: one card per engine with its resolved path and
  origin, **Install**, **Use my own binary…**, **Test** (renders a sample
  inline) and **Remove**.
- D2 can be installed from the plugin (~17 MB), not just found on `PATH`.
- Custom `dot`, PlantUML and D2 paths, editable from the screen or the settings
  form; a path that no longer exists is reported instead of silently ignored.
- `autoDownload` replaces `downloadPlantUml` and covers D2 as well.
- Two engine processes at a time; identical diagrams share one render.
- Chat and preview keep an in-memory SVG cache; previews render lazily near the
  viewport and only scan DOM changes inside a preview panel.
- Fewer bundled files and one less runtime dependency.
