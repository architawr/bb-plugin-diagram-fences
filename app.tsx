// bb-plugin-diagram-fences — frontend.
//
// Two surfaces:
//   * a code-fence renderer for assistant messages (plantuml, d2, dot, …)
//   * a settings section that installs, points and tests each local engine
// plus a content script (lib/preview.ts) that draws the same fences inside
// BB's Markdown file preview, where the fence slot does not reach.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useSettings,
  type ExperimentalCodeFenceRendererProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { fingerprint } from "./lib/hash";
import { DIAGRAM_LANGUAGES } from "./lib/languages";
import { mountPreviewDiagrams } from "./lib/preview";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type RenderState =
  | { kind: "loading" }
  | { kind: "ready"; svg: string; engine: string; cached: boolean }
  | { kind: "error"; message: string };

type EngineId = "graphviz" | "plantuml" | "d2";
type EngineStatus = {
  id: EngineId;
  label: string;
  available: boolean;
  detail: string;
  source: string | null;
  path: string | null;
  canInstall: boolean;
  canRemove: boolean;
  downloading: boolean;
  custom: string;
};
type Status = {
  mode: string;
  krokiUrl: string;
  cacheEntries: number;
  engines: EngineStatus[];
};

/** Engines that can draw without a network at all. */
const LOCAL_LANGUAGES = new Set([
  "plantuml",
  "puml",
  "uml",
  "c4plantuml",
  "c4",
  "dot",
  "graphviz",
  "gv",
  "d2",
]);

/** The app toggles `.dark` on <html>; diagram colors follow it. */
function useDarkMode(): boolean {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

const ENGINE_LABEL: Record<string, string> = {
  "graphviz-dot": "graphviz",
  "graphviz-wasm": "graphviz",
  plantuml: "plantuml",
  d2: "d2",
  kroki: "kroki",
};

function ToolbarButton({
  label,
  icon,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

type CachedRender = { svg: string; engine: string };
const RENDER_CACHE_LIMIT = 80;
const renderCache = new Map<string, CachedRender>();

function renderKey(mode: string, language: string, theme: string, source: string): string {
  return `${mode}|${language}|${theme}|${source.length}|${fingerprint(source)}`;
}

function rememberRender(key: string, value: CachedRender) {
  renderCache.delete(key);
  renderCache.set(key, value);
  while (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCache.delete(oldest);
  }
}

function DiagramBlock({
  language,
  source,
  Original,
}: {
  language: string;
  source: string;
  Original: ExperimentalCodeFenceRendererProps["Original"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const dark = useDarkMode();
  const settingValues = useSettings().values;
  const mode = typeof settingValues?.mode === "string" ? settingValues.mode : "auto";
  const theme = dark ? "dark" : "light";
  const key = renderKey(mode, language, theme, source);
  const [state, setState] = useState<RenderState>(() => {
    const hit = renderCache.get(key);
    return hit === undefined
      ? { kind: "loading" }
      : { kind: "ready", svg: hit.svg, engine: hit.engine, cached: true };
  });
  const [attempt, setAttempt] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  // An engine or a path may change in the background; drop cached SVGs and redraw.
  useRealtime("engine-ready", () => {
    renderCache.clear();
    setAttempt((value) => value + 1);
  });

  useEffect(() => {
    const hit = renderCache.get(key);
    if (hit !== undefined) {
      setState({ kind: "ready", svg: hit.svg, engine: hit.engine, cached: true });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    rpc.call("render", { language, source, theme }).then(
      (result) => {
        rememberRender(key, { svg: result.svg, engine: result.engine });
        if (!cancelled) {
          setState({
            kind: "ready",
            svg: result.svg,
            engine: result.engine,
            cached: result.cached,
          });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, key, attempt, language, source, theme]);

  useEffect(() => {
    if (state.kind !== "ready") {
      setUrl(null);
      return;
    }
    // An <img> cannot run scripts, so a diagram from Kroki or a local engine
    // is safe to show without trusting or sanitizing its SVG.
    const next = URL.createObjectURL(new Blob([state.svg], { type: "image/svg+xml" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [state]);

  const copySource = useCallback(() => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [source]);

  if (state.kind === "error") {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed">
        <div className="flex items-center gap-2 px-3 pt-2">
          <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={state.message}>
            {language}: {state.message}
          </span>
          <ToolbarButton label="Try again" icon="RotateCw" onClick={() => setAttempt((value) => value + 1)} />
          <ToolbarButton
            label={showSource ? "Hide source" : "Show source"}
            icon="Code"
            pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          />
        </div>
        {showSource ? (
          <pre className="overflow-x-auto px-3 pb-3 pt-2">
            <code className="font-mono text-xs">{source}</code>
          </pre>
        ) : (
          <div className="pt-2">
            <Original />
          </div>
        )}
      </div>
    );
  }

  const engineLabel = state.kind === "ready" ? (ENGINE_LABEL[state.engine] ?? state.engine) : null;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed">
      <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 pt-1.5">
        <span className="truncate font-mono text-xs uppercase text-muted-foreground">
          {language}
          {engineLabel === null ? "" : ` · ${engineLabel}`}
        </span>
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            label={showSource ? "Hide source" : "Show source"}
            icon="Code"
            pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          />
          <ToolbarButton
            label={copied ? "Copied" : "Copy source"}
            icon={copied ? "Check" : "Copy"}
            onClick={copySource}
          />
          <ToolbarButton
            label="Open diagram in a new tab"
            icon="Maximize2"
            disabled={url === null}
            onClick={() => {
              if (url !== null) window.open(url, "_blank", "noopener");
            }}
          />
        </div>
      </div>
      {showSource ? (
        <pre className="overflow-x-auto px-3 pb-3 pt-2">
          <code className="font-mono text-xs">{source}</code>
        </pre>
      ) : url === null ? (
        <div className="flex min-h-24 items-center justify-center px-3 pb-3 pt-2 text-xs text-muted-foreground">
          Rendering diagram…
        </div>
      ) : (
        <div className="overflow-x-auto px-3 pb-3 pt-2">
          <img src={url} alt={`${language} diagram`} className="mx-auto block h-auto max-w-full" />
        </div>
      )}
    </div>
  );
}

function DiagramFence({ language, status, code, Original }: ExperimentalCodeFenceRendererProps) {
  // A half-written diagram cannot be parsed; keep BB's block until it closes.
  if (status === "streaming") return <Original />;
  return <DiagramBlock language={language} source={code} Original={Original} />;
}

// ----------------------------------------------------------------- settings

function Pill({
  children,
  tone,
}: {
  children: string;
  tone: "good" | "warn" | "info" | "muted";
}) {
  const className =
    tone === "good"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : tone === "info"
          ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
          : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  );
}

function enginePill(engine: EngineStatus): { text: string; tone: "good" | "warn" | "info" | "muted" } {
  if (engine.downloading) return { text: "Downloading…", tone: "warn" };
  if (!engine.available) return { text: "Not installed", tone: "muted" };
  if (engine.source === "custom") return { text: "Custom path", tone: "info" };
  if (engine.source === "downloaded") return { text: "Installed", tone: "good" };
  if (engine.source === "bundled") return { text: "Bundled", tone: "good" };
  return { text: "On PATH", tone: "good" };
}

function EngineCard({ engine, onChanged }: { engine: EngineStatus; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(engine.custom);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [test, setTest] = useState<
    { kind: "ok"; url: string } | { kind: "error"; message: string } | null
  >(null);

  useEffect(() => {
    setDraft(engine.custom);
  }, [engine.custom]);

  useEffect(() => {
    if (test === null || test.kind !== "ok") return;
    const url = test.url;
    return () => URL.revokeObjectURL(url);
  }, [test]);

  const pill = enginePill(engine);

  const run = useCallback(
    (action: string, task: () => Promise<string | null>) => {
      setBusy(action);
      setNote(null);
      task().then(
        (message) => {
          setBusy(null);
          if (message !== null) setNote(message);
          onChanged();
        },
        (cause: unknown) => {
          setBusy(null);
          setNote(cause instanceof Error ? cause.message : String(cause));
        },
      );
    },
    [onChanged],
  );

  const install = () =>
    run("install", async () => {
      const result = await rpc.call("engine_install", { engine: engine.id });
      if (result.path !== null) return `Ready at ${result.path}`;
      return "Downloading in the background — this panel updates itself when it finishes.";
    });

  const remove = () =>
    run("remove", async () => {
      const result = await rpc.call("engine_remove", { engine: engine.id });
      return result.removed ? "Removed the downloaded engine." : "Nothing to remove.";
    });

  const save = () =>
    run("save", async () => {
      const result = await rpc.call("engine_set_path", { engine: engine.id, path: draft });
      setEditing(false);
      return result.path === null ? "Falling back to the automatic lookup." : `Using ${result.path}`;
    });

  const runTest = () =>
    run("test", async () => {
      setTest(null);
      const result = await rpc.call("engine_test", { engine: engine.id });
      if (!result.ok || result.svg === undefined) {
        setTest({ kind: "error", message: result.error ?? "the engine returned nothing" });
        return null;
      }
      const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
      setTest({ kind: "ok", url });
      return null;
    });

  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{engine.label}</div>
          <div className="truncate text-xs text-muted-foreground" title={engine.detail}>
            {engine.detail}
          </div>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {engine.canInstall ? (
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={install}>
            {busy === "install" ? "Starting…" : "Install"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            setEditing((value) => !value);
            setNote(null);
          }}
        >
          {engine.custom.length > 0 ? "Change path…" : "Use my own binary…"}
        </Button>
        {engine.available ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={runTest}>
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
        ) : null}
        {engine.canRemove ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={remove}>
            Remove
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Full path to the ${engine.id} binary`}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <Button type="button" size="sm" disabled={busy !== null} onClick={save}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setDraft("");
              setEditing(false);
              setNote(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {note === null ? null : <div className="mt-2 text-xs text-muted-foreground">{note}</div>}

      {test === null ? null : test.kind === "ok" ? (
        <img
          src={test.url}
          alt={`${engine.label} test diagram`}
          className="mt-2 max-h-48 w-auto rounded border border-border bg-white p-2"
        />
      ) : (
        <div className="mt-2 text-xs text-destructive">{test.message}</div>
      )}
    </div>
  );
}

function DiagramSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("status").then(
      (value) => {
        setStatus(value);
        setMessage(null);
      },
      (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime("engine-ready", refresh);

  const clearCache = useCallback(() => {
    setBusy("clear");
    rpc.call("clear_cache").then(
      (result) => {
        setBusy(null);
        setMessage(`Removed ${result.removed} cached diagram${result.removed === 1 ? "" : "s"}.`);
        refresh();
      },
      (cause: unknown) => {
        setBusy(null);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc, refresh]);

  const krokiOnly = DIAGRAM_LANGUAGES.filter((language) => !LOCAL_LANGUAGES.has(language));

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Mode <span className="font-medium text-foreground">{status?.mode ?? "…"}</span>
        </span>
        <span className="truncate">Kroki {status?.krokiUrl}</span>
        <span>
          {status?.cacheEntries ?? 0} cached diagram{status?.cacheEntries === 1 ? "" : "s"}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2" disabled={busy !== null} onClick={clearCache}>
          Clear cache
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2" disabled={busy !== null} onClick={refresh}>
          Refresh
        </Button>
      </div>

      {status === null ? (
        <div className="text-xs text-muted-foreground">Reading engine status…</div>
      ) : (
        <div className="grid gap-2">
          {status.engines.map((engine) => (
            <EngineCard key={engine.id} engine={engine} onChanged={refresh} />
          ))}
        </div>
      )}

      {message === null ? null : <div className="text-xs text-muted-foreground">{message}</div>}

      <p className="text-xs text-muted-foreground">
        Nothing keeps running: Graphviz uses <code>dot</code> or the bundled WASM, PlantUML and D2
        are short-lived binaries, and every diagram is cached by its source. Engine paths can also
        be set on the plugin settings form above.
      </p>
      <p className="text-xs text-muted-foreground">
        Kroki-only languages ({krokiOnly.length}): <span className="text-foreground/80">{krokiOnly.join(", ")}</span>.
        They need the public kroki.io, a custom Kroki URL, or a local binary for that language.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_codeFenceRenderer({
    id: "diagram-fences",
    languages: [...DIAGRAM_LANGUAGES],
    component: DiagramFence,
  });

  app.slots.settingsSection({
    id: "diagram-engines",
    title: "Diagram engines",
    description: "Install a local engine, point it at your own binary, or test what already works.",
    component: DiagramSettings,
  });

  app.contentScripts.register({
    id: "preview-diagrams",
    mount: ({ pluginId, signal }) => mountPreviewDiagrams(pluginId, signal),
  });
});
