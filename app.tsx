// bb-plugin-diagram-fences — frontend.
//
// Two surfaces:
//   * a code-fence renderer for assistant messages (plantuml, d2, dot, …)
//   * a settings section that shows which local engines exist and can fetch
//     the PlantUML one
// plus a content script (lib/preview.ts) that draws the same fences inside
// BB's Markdown file preview, where the fence slot does not reach.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type ExperimentalCodeFenceRendererProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { DIAGRAM_LANGUAGES } from "./lib/languages";
import { mountPreviewDiagrams } from "./lib/preview";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type RenderState =
  | { kind: "loading" }
  | { kind: "ready"; svg: string; engine: string; cached: boolean }
  | { kind: "error"; message: string };

type EngineStatus = {
  id: string;
  label: string;
  available: boolean;
  detail: string;
};
type Status = {
  mode: string;
  krokiUrl: string;
  cacheEntries: number;
  engines: EngineStatus[];
};

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
  const [state, setState] = useState<RenderState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  // The PlantUML engine downloads in the background; redraw once it is ready.
  useRealtime("engine-ready", () => setAttempt((value) => value + 1));

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    rpc.call("render", { language, source, theme: dark ? "dark" : "light" }).then(
      (result) => {
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
  }, [rpc, language, source, dark, attempt]);

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

function EngineRow({ engine }: { engine: EngineStatus }) {
  return (
    <li className="flex items-start gap-2 py-1 text-sm">
      <Icon
        name={engine.available ? "CircleCheck" : "Circle"}
        className={engine.available ? "mt-0.5 size-4 shrink-0 text-emerald-500" : "mt-0.5 size-4 shrink-0 text-muted-foreground"}
      />
      <div className="min-w-0">
        <div className="font-medium">{engine.label}</div>
        <div className="truncate text-xs text-muted-foreground" title={engine.detail}>
          {engine.detail}
        </div>
      </div>
    </li>
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

  const download = useCallback(() => {
    setBusy("download");
    rpc.call("download_plantuml").then(
      (result) => {
        setBusy(null);
        setMessage(
          result.path !== null
            ? `PlantUML engine: ${result.path}`
            : "Downloading the PlantUML engine — it appears here when ready.",
        );
        refresh();
      },
      (cause: unknown) => {
        setBusy(null);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc, refresh]);

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

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-muted-foreground">
          Mode: <span className="font-medium text-foreground">{status?.mode ?? "…"}</span>
          {status ? <span className="text-muted-foreground"> · Kroki {status.krokiUrl}</span> : null}
        </div>
        <div className="text-muted-foreground">
          {status?.cacheEntries ?? 0} cached diagram{status?.cacheEntries === 1 ? "" : "s"}
        </div>
      </div>

      {status === null ? null : (
        <ul>
          {status.engines.map((engine) => (
            <EngineRow key={engine.id} engine={engine} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={download}>
          {busy === "download" ? "Starting…" : "Download PlantUML engine"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={clearCache}>
          Clear cache
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={refresh}>
          Refresh
        </Button>
      </div>

      {message ? <div className="text-xs text-muted-foreground">{message}</div> : null}

      <p className="text-xs text-muted-foreground">
        Local rendering uses <code>dot</code> or the bundled Graphviz WASM, a native PlantUML binary
        downloaded on demand, and <code>d2</code> when it is installed. Nothing keeps running: each
        engine is a short-lived process, and every diagram is cached by its source.
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
    description: "Where PlantUML, Graphviz, D2 and the rest are drawn, and which local engines exist.",
    component: DiagramSettings,
  });

  app.contentScripts.register({
    id: "preview-diagrams",
    mount: ({ pluginId, signal }) => mountPreviewDiagrams(pluginId, signal),
  });
});
