/**
 * Fenced-code languages this plugin draws, and how each one maps onto a
 * rendering engine. Shared by the server (rendering) and the app (fence
 * renderer + preview content script), so both agree on what is claimed.
 */

/** Every fence language the plugin claims. BB hands these to our renderer. */
export const DIAGRAM_LANGUAGES = [
  "plantuml",
  "puml",
  "uml",
  "c4plantuml",
  "c4",
  "d2",
  "dot",
  "graphviz",
  "gv",
  "structurizr",
  "excalidraw",
  "nomnoml",
  "wavedrom",
  "bytefield",
  "svgbob",
  "dbml",
  "bpmn",
  "ditaa",
  "erd",
  "pikchr",
  "wireviz",
  "symbolator",
  "umlet",
  "vega",
  "vegalite",
  "tikz",
  "goat",
  "lini",
  "blockdiag",
  "seqdiag",
  "actdiag",
  "nwdiag",
  "rackdiag",
  "packetdiag",
] as const;

export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

export type DiagramEngine = "graphviz" | "plantuml" | "d2" | "kroki";
export type LocalDiagramEngine = Exclude<DiagramEngine, "kroki">;

/** Human-facing engine label for the fence header. */
export const ENGINE_LABELS: Record<string, string> = {
  "graphviz-dot": "graphviz",
  "graphviz-wasm": "graphviz",
  plantuml: "plantuml",
  d2: "d2",
  kroki: "kroki.io",
};

const LANGUAGE_SET = new Set<string>(DIAGRAM_LANGUAGES);

/** Lowercased info string, trimmed of anything after a space (```plantuml title). */
export function normalizeLanguage(input: string): string {
  const base = input.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return base;
}

export function isDiagramLanguage(language: string): boolean {
  return LANGUAGE_SET.has(normalizeLanguage(language));
}

/** Kroki path segment for a language. PlantUML/DOT have aliases. */
export function krokiSlug(language: string): string {
  const lang = normalizeLanguage(language);
  switch (lang) {
    case "puml":
    case "uml":
      return "plantuml";
    case "dot":
    case "gv":
      return "graphviz";
    case "c4":
      return "c4plantuml";
    default:
      return lang;
  }
}

/** Which local engine, if any, can draw this language without a server. */
export function localEngineFor(language: string): LocalDiagramEngine | null {
  switch (krokiSlug(language)) {
    case "plantuml":
      return "plantuml";
    case "graphviz":
      return "graphviz";
    case "d2":
      return "d2";
    default:
      return null;
  }
}
