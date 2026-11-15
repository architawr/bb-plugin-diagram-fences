// bb-plugin-diagram-fences — backend.
//
// Draws fenced PlantUML, Graphviz/dot, D2 and the rest of the Kroki family in
// assistant replies (and, through the content script in app.tsx, in Markdown
// file previews). Four rendering routes, picked in Settings:
//
//   auto   — a local engine when this machine has one, kroki.io otherwise
//   local  — only this machine; an unsupported language is an error, and so is
//            a missing engine
//   kroki  — the public kroki.io service, nothing runs locally
//   custom — a self-hosted Kroki (or any compatible gateway)
//
// Local engines never stay running: graphviz is either `dot` spawned per
// diagram or a lazily created WASM instance, PlantUML and D2 are native
// binaries that exit after one render. Every engine can be installed from the
// settings screen or pointed at a binary the user already has. Every SVG is
// cached by content hash, so a diagram is drawn once per machine.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DIAGRAM_LANGUAGES,
  krokiSlug,
  localEngineFor,
  normalizeLanguage,
} from "./lib/languages";

const PLANTUML_VERSION = "1.2026.10";
const D2_VERSION = "0.9.0";

/** PlantUML publishes native (GraalVM) builds — no Java runtime needed. */
const PLANTUML_ASSETS: Record<string, string> = {
  "darwin-arm64": "native-plantuml-macos-arm64",
  "linux-x64": "native-plantuml-linux-amd64",
  "linux-arm64": "native-plantuml-linux-arm64",
  "win32-x64": "native-plantuml-windows-amd64",
};

const D2_ASSETS: Record<string, string> = {
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-amd64",
  "linux-x64": "linux-amd64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-amd64",
  "win32-arm64": "windows-arm64",
};

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_CACHED_SVG_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const KROKI_TIMEOUT_MS = 20_000;
const ENGINE_READY = "engine-ready";

const themeSchema = z.enum(["light", "dark"]);
const engineIdSchema = z.enum(["graphviz", "plantuml", "d2"]);

type EngineId = z.infer<typeof engineIdSchema>;
type Theme = z.infer<typeof themeSchema>;

const ENGINE_LABELS: Record<EngineId, string> = {
  graphviz: "Graphviz",
  plantuml: "PlantUML",
  d2: "D2",
};

const ENGINE_SETTING_KEYS: Record<EngineId, "graphvizPath" | "plantumlPath" | "d2Path"> = {
  graphviz: "graphvizPath",
  plantuml: "plantumlPath",
  d2: "d2Path",
};

export const rpcContract = defineRpcContract({
  render: {
    input: z
      .object({
        language: z.string().min(1).max(60),
        source: z.string().min(1),
        theme: themeSchema.default("light"),
      })
      .strict(),
    output: z.object({
      svg: z.string(),
      engine: z.string(),
      cached: z.boolean(),
      ms: z.number(),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      mode: z.string(),
      krokiUrl: z.string(),
      cacheEntries: z.number(),
      engines: z.array(
        z.object({
          id: engineIdSchema,
          label: z.string(),
          available: z.boolean(),
          detail: z.string(),
          source: z.string().nullable(),
          path: z.string().nullable(),
          canInstall: z.boolean(),
          canRemove: z.boolean(),
          downloading: z.boolean(),
          custom: z.string(),
        }),
      ),
    }),
  },
  engine_install: {
    input: z.object({ engine: engineIdSchema }).strict(),
    output: z.object({ started: z.boolean(), path: z.string().nullable() }),
  },
  engine_remove: {
    input: z.object({ engine: engineIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  engine_set_path: {
    input: z
      .object({ engine: engineIdSchema, path: z.string().max(4096) })
      .strict(),
    output: z.object({ path: z.string().nullable() }),
  },
  engine_test: {
    input: z.object({ engine: engineIdSchema }).strict(),
    output: z.object({
      ok: z.boolean(),
      svg: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  clear_cache: {
    input: z.null(),
    output: z.object({ removed: z.number() }),
  },
});

interface RenderRequest {
  language: string;
  source: string;
  theme: Theme;
}

interface RenderResult {
  svg: string;
  engine: string;
  cached: boolean;
  ms: number;
}

/** Runs a child process, feeding it stdin and returning stdout. */
function runProcess(
  command: string,
  args: string[],
  input: string,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;

    function finish(error: Error | null, value?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(command)} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("diagram output is larger than 12 MB"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      finish(cause instanceof Error ? cause : new Error(String(cause)));
    });
    child.on("close", (code, signal) => {
      if (code === 0) finish(null, stdout);
      else {
        finish(
          new Error(
            stderr.trim() ||
              `${path.basename(command)} exited with ${code ?? signal ?? "no status"}`,
          ),
        );
      }
    });
    child.stdin.on("error", () => {
      /* the process may exit before reading stdin; close() carries the verdict */
    });
    child.stdin.end(input);
  });
}

/** `which`, cached: engine probes must not shell out on every render. */
const executableCache = new Map<string, string | null>();
async function findExecutable(name: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  const cached = executableCache.get(name);
  if (cached !== undefined) return cached;
  try {
    const found = (await runProcess("which", [name], "", 5_000)).trim().split("\n")[0];
    const value = found && found.length > 0 ? found : null;
    executableCache.set(name, value);
    return value;
  } catch {
    executableCache.set(name, null);
    return null;
  }
}

/** Graphviz through the WASM build when `dot` is not installed. */
let vizPromise: Promise<{ renderString: (source: string, options?: object) => string }> | null = null;
async function vizInstance() {
  vizPromise ??= import("@viz-js/viz").then((module) => module.instance());
  return vizPromise;
}

/** Graphviz writes literal black; in dark mode swap it for the app foreground. */
function recolorGraphviz(svg: string): string {
  return svg
    .replace(/fill="(?:black|#000000|#000)"/gi, 'fill="#e6e6ea"')
    .replace(/stroke="(?:black|#000000|#000)"/gi, 'stroke="#c8c8d0"');
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Kroki answers a bad diagram with an SVG of the parse error; keep its text. */
function describeKrokiError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.includes("<svg")) {
    return trimmed.slice(0, 300).replace(/\s+/g, " ");
  }
  const text = trimmed
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 300) || "the diagram could not be parsed";
}

interface EngineState {
  id: EngineId;
  available: boolean;
  detail: string;
  source: "custom" | "downloaded" | "path" | "bundled" | null;
  path: string | null;
  canInstall: boolean;
  canRemove: boolean;
  downloading: boolean;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    mode: {
      type: "select",
      label: "Where to render diagrams",
      options: ["auto", "local", "kroki", "custom"],
      experimental_optionLabels: {
        auto: "Auto — this machine when possible, kroki.io otherwise",
        local: "This machine only",
        kroki: "kroki.io (public service)",
        custom: "Own Kroki URL",
      },
      default: "auto",
    },
    krokiUrl: {
      type: "string",
      label: "Kroki URL (used by Custom mode)",
      default: "https://kroki.io",
    },
    autoDownload: {
      type: "boolean",
      label: "Download a missing local engine when a diagram needs it",
      default: true,
    },
    graphvizPath: {
      type: "string",
      label: "Custom dot binary (optional, overrides the lookup)",
      default: "",
    },
    plantumlPath: {
      type: "string",
      label: "Custom PlantUML binary (optional, overrides the lookup)",
      default: "",
    },
    d2Path: {
      type: "string",
      label: "Custom d2 binary (optional, overrides the lookup)",
      default: "",
    },
    cacheEntries: {
      type: "number",
      label: "Cached diagrams kept on disk",
      experimental_schema: z.number().int().min(0).max(5_000),
      default: 400,
    },
    maxSourceKb: {
      type: "number",
      label: "Largest diagram source (KB)",
      experimental_schema: z.number().int().min(1).max(512),
      default: 64,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `create table if not exists diagram_cache (
       hash text primary key,
       language text not null,
       engine text not null,
       svg text not null,
       created_at integer not null
     );`,
    `create index if not exists diagram_cache_created_at on diagram_cache (created_at);`,
  ]);

  const readCached = db.prepare(
    "select svg, engine from diagram_cache where hash = ?",
  );
  const touchCached = db.prepare(
    "update diagram_cache set created_at = ? where hash = ?",
  );
  const writeCached = db.prepare(
    "insert or replace into diagram_cache (hash, language, engine, svg, created_at) values (?, ?, ?, ?, ?)",
  );
  const countCached = db.prepare("select count(*) as n from diagram_cache");
  const trimCached = db.prepare(
    "delete from diagram_cache where hash in (select hash from diagram_cache order by created_at asc limit ?)",
  );
  const clearCached = db.prepare("delete from diagram_cache");

  function cacheLookup(hash: string): { svg: string; engine: string } | null {
    const row = readCached.get(hash) as { svg: string; engine: string } | undefined;
    if (!row) return null;
    touchCached.run(Date.now(), hash);
    return row;
  }

  function cacheStore(hash: string, language: string, result: RenderResult, limit: number) {
    if (limit <= 0 || result.svg.length > MAX_CACHED_SVG_BYTES) return;
    writeCached.run(hash, language, result.engine, result.svg, Date.now());
    const total = (countCached.get() as { n: number }).n;
    if (total > limit) trimCached.run(total - limit);
  }

  async function effective() {
    const values = await settings.get();
    return {
      mode: values.mode,
      krokiUrl: values.krokiUrl.trim() || "https://kroki.io",
      autoDownload: values.autoDownload,
      graphvizPath: values.graphvizPath.trim(),
      plantumlPath: values.plantumlPath.trim(),
      d2Path: values.d2Path.trim(),
      cacheEntries: values.cacheEntries,
      maxSourceKb: values.maxSourceKb,
    };
  }
  type Config = Awaited<ReturnType<typeof effective>>;

  // ------------------------------------------------------- downloaded engines

  function enginesRoot(): string {
    // <dataDir>/plugins/<id>/ is this plugin's own directory (data.db lives there).
    return path.join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "engines");
  }

  function plantumlHome(): string {
    return path.join(enginesRoot(), `plantuml-${PLANTUML_VERSION}`);
  }

  function d2Home(): string {
    return path.join(enginesRoot(), `d2-${D2_VERSION}`);
  }

  function plantumlBinary(): string | null {
    const candidate = path.join(
      plantumlHome(),
      process.platform === "win32" ? "plantuml.exe" : "plantuml",
    );
    return existsSync(candidate) ? candidate : null;
  }

  function d2Binary(): string | null {
    const candidate = path.join(
      d2Home(),
      `d2-v${D2_VERSION}`,
      "bin",
      process.platform === "win32" ? "d2.exe" : "d2",
    );
    return existsSync(candidate) ? candidate : null;
  }

  const downloads = new Map<EngineId, Promise<string | null>>();

  async function extractArchive(
    archive: string,
    directory: string,
    kind: "zip" | "tar.gz",
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    if (kind === "zip") {
      try {
        await runProcess("unzip", ["-o", "-q", archive, "-d", directory], "", 120_000);
      } catch (cause) {
        await runProcess("ditto", ["-x", "-k", archive, directory], "", 120_000).catch(() => {
          throw cause;
        });
      }
      return;
    }
    await runProcess("tar", ["-xzf", archive, "-C", directory], "", 120_000);
  }

  async function fetchArchive(url: string, destination: string): Promise<void> {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }

  async function downloadPlantuml(): Promise<string | null> {
    const asset = PLANTUML_ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) {
      throw new Error(
        `PlantUML has no native build for ${process.platform}-${process.arch}; point the custom path at a plantuml binary instead`,
      );
    }
    const home = plantumlHome();
    const archive = path.join(home, "plantuml.zip");
    const url = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/${asset}-${PLANTUML_VERSION}.zip`;
    bb.log.info(`downloading PlantUML ${PLANTUML_VERSION} (${asset})`);
    await fetchArchive(url, archive);
    await extractArchive(archive, home, "zip");
    await rm(archive, { force: true });
    const binary = path.join(
      home,
      process.platform === "win32" ? "plantuml.exe" : "plantuml",
    );
    await chmod(binary, 0o755);
    bb.log.info(`PlantUML engine ready at ${binary}`);
    bb.realtime.publish(ENGINE_READY, { engine: "plantuml" });
    return binary;
  }

  async function downloadD2(): Promise<string | null> {
    const asset = D2_ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) {
      throw new Error(
        `D2 has no build for ${process.platform}-${process.arch}; install d2 yourself and set the custom path`,
      );
    }
    const home = d2Home();
    const archive = path.join(home, `d2.tar.gz`);
    const url = `https://github.com/terrastruct/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-${asset}.tar.gz`;
    bb.log.info(`downloading D2 ${D2_VERSION} (${asset})`);
    await fetchArchive(url, archive);
    await extractArchive(archive, home, "tar.gz");
    await rm(archive, { force: true });
    const binary = path.join(
      home,
      `d2-v${D2_VERSION}`,
      "bin",
      process.platform === "win32" ? "d2.exe" : "d2",
    );
    await chmod(binary, 0o755);
    bb.log.info(`D2 engine ready at ${binary}`);
    bb.realtime.publish(ENGINE_READY, { engine: "d2" });
    return binary;
  }

  function startDownload(engine: EngineId): void {
    if (engine === "graphviz" || downloads.has(engine)) return;
    const job = (engine === "plantuml" ? downloadPlantuml() : downloadD2())
      .catch((cause: unknown) => {
        bb.log.warn(
          `${ENGINE_LABELS[engine]} download failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        bb.realtime.publish(ENGINE_READY, { engine, failed: true });
        return null;
      })
      .finally(() => {
        downloads.delete(engine);
      });
    downloads.set(engine, job);
  }

  // --------------------------------------------------------- engine resolving

  function customPath(config: Config, engine: EngineId): string | null {
    const value = config[ENGINE_SETTING_KEYS[engine]];
    if (value.length === 0) return null;
    return existsSync(value) ? value : null;
  }

  async function resolveEngine(engine: EngineId, config: Config): Promise<EngineState> {
    const custom = customPath(config, engine);
    const downloading = downloads.has(engine);
    if (engine === "graphviz") {
      if (custom) {
        return {
          id: engine,
          available: true,
          detail: custom,
          source: "custom",
          path: custom,
          canInstall: false,
          canRemove: false,
          downloading,
        };
      }
      const dot = await findExecutable("dot");
      if (dot) {
        return {
          id: engine,
          available: true,
          detail: dot,
          source: "path",
          path: dot,
          canInstall: false,
          canRemove: false,
          downloading,
        };
      }
      return {
        id: engine,
        available: true,
        detail: "bundled WASM renderer",
        source: "bundled",
        path: null,
        canInstall: false,
        canRemove: false,
        downloading,
      };
    }
    const downloaded = engine === "plantuml" ? plantumlBinary() : d2Binary();
    if (custom) {
      return {
        id: engine,
        available: true,
        detail: custom,
        source: "custom",
        path: custom,
        canInstall: false,
        canRemove: downloaded !== null,
        downloading,
      };
    }
    if (downloaded) {
      return {
        id: engine,
        available: true,
        detail: "installed by this plugin",
        source: "downloaded",
        path: downloaded,
        canInstall: false,
        canRemove: true,
        downloading,
      };
    }
    const found = await findExecutable(engine);
    if (found) {
      return {
        id: engine,
        available: true,
        detail: found,
        source: "path",
        path: found,
        canInstall: true,
        canRemove: false,
        downloading,
      };
    }
    return {
      id: engine,
      available: false,
      detail: downloading ? "downloading…" : "not installed — diagrams use Kroki",
      source: null,
      path: null,
      canInstall: !downloading && Boolean((engine === "plantuml" ? PLANTUML_ASSETS : D2_ASSETS)[`${process.platform}-${process.arch}`]),
      canRemove: false,
      downloading,
    };
  }

  // ---------------------------------------------------------------- renderers

  async function renderGraphviz(source: string, theme: Theme, config: Config): Promise<{ svg: string; engine: string }> {
    const dot = customPath(config, "graphviz") ?? (await findExecutable("dot"));
    if (dot) {
      const svg = await runProcess(dot, ["-Tsvg"], source);
      return { svg: theme === "dark" ? recolorGraphviz(svg) : svg, engine: "graphviz-dot" };
    }
    const viz = await vizInstance();
    const svg = viz.renderString(source, { format: "svg" });
    return { svg: theme === "dark" ? recolorGraphviz(svg) : svg, engine: "graphviz-wasm" };
  }

  async function renderPlantuml(source: string, theme: Theme, binary: string): Promise<{ svg: string; engine: string }> {
    const base = ["-tsvg", "-pipe", "-charset", "UTF-8"];
    try {
      const svg = await runProcess(binary, theme === "dark" ? [...base, "-darkmode"] : base, source);
      return { svg, engine: "plantuml" };
    } catch (cause) {
      if (theme !== "dark") throw cause;
      // Older builds do not know -darkmode; a light diagram beats no diagram.
      const svg = await runProcess(binary, base, source);
      return { svg, engine: "plantuml" };
    }
  }

  async function renderD2(source: string, theme: Theme, binary: string): Promise<{ svg: string; engine: string }> {
    const args = ["--layout", "dagre", "-", "--stdout-format", "svg"];
    if (theme === "dark") args.push("--theme", "200");
    const svg = await runProcess(binary, args, source);
    return { svg, engine: "d2" };
  }

  async function renderKroki(baseUrl: string, language: string, source: string): Promise<{ svg: string; engine: string }> {
    const url = `${baseUrl.replace(/\/+$/, "")}/${krokiSlug(language)}/svg`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "image/svg+xml" },
      body: source,
      signal: AbortSignal.timeout(KROKI_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kroki HTTP ${response.status}: ${describeKrokiError(body)}`);
    }
    return { svg: await response.text(), engine: "kroki" };
  }

  async function renderLocal(
    engine: EngineId,
    source: string,
    theme: Theme,
    config: Config,
    state: EngineState,
  ): Promise<{ svg: string; engine: string }> {
    if (engine === "graphviz") return renderGraphviz(source, theme, config);
    if (state.path === null) throw new Error(`${ENGINE_LABELS[engine]} is not available`);
    return engine === "plantuml"
      ? renderPlantuml(source, theme, state.path)
      : renderD2(source, theme, state.path);
  }

  // ----------------------------------------------------------------- render

  const inFlight = new Map<string, Promise<{ svg: string; engine: string }>>();

  async function render(input: RenderRequest): Promise<RenderResult> {
    const startedAt = Date.now();
    const language = normalizeLanguage(input.language);
    const source = input.source;
    const config = await effective();
    if (source.length > config.maxSourceKb * 1024) {
      throw new Error(`diagram source is larger than ${config.maxSourceKb} KB`);
    }

    const hash = sha256(`${language}\u0000${input.theme}\u0000${source}`);
    const cached = cacheLookup(hash);
    if (cached) {
      return { svg: cached.svg, engine: cached.engine, cached: true, ms: Date.now() - startedAt };
    }

    const pending = inFlight.get(hash);
    if (pending) {
      const result = await pending;
      return { ...result, cached: false, ms: Date.now() - startedAt };
    }

    const job = (async (): Promise<{ svg: string; engine: string }> => {
      const local = localEngineFor(language);
      const wantsLocal = config.mode === "auto" || config.mode === "local";

      if (wantsLocal && local !== null) {
        const state = await resolveEngine(local, config);
        if (state.available && (local === "graphviz" || state.path !== null)) {
          return renderLocal(local, source, input.theme, config, state);
        }
        if (config.mode === "local") {
          if (config.autoDownload && local !== "graphviz") {
            startDownload(local);
            throw new Error(
              `${ENGINE_LABELS[local]} is downloading; the diagram appears on the next message`,
            );
          }
          throw new Error(
            `the local ${ENGINE_LABELS[local]} engine is not available — install it from settings, set a custom path, or use Auto / kroki.io`,
          );
        }
        if (config.autoDownload && local !== "graphviz") startDownload(local);
      }

      if (config.mode === "local") {
        throw new Error(
          local === null
            ? `no local engine draws ${language}; use Auto or kroki.io`
            : `the local ${ENGINE_LABELS[local]} engine is not available`,
        );
      }
      if (!config.krokiUrl) throw new Error("the Kroki URL is empty");
      return renderKroki(config.krokiUrl, language, source);
    })();

    inFlight.set(hash, job);
    try {
      const result = await job;
      const output = { ...result, cached: false, ms: Date.now() - startedAt };
      cacheStore(hash, language, output, config.cacheEntries);
      return output;
    } finally {
      inFlight.delete(hash);
    }
  }

  async function status() {
    const config = await effective();
    const engines = await Promise.all(
      (["graphviz", "plantuml", "d2"] as const).map(async (engine) => {
        const state = await resolveEngine(engine, config);
        return {
          ...state,
          label: ENGINE_LABELS[engine],
          custom: config[ENGINE_SETTING_KEYS[engine]],
        };
      }),
    );
    return {
      mode: config.mode,
      krokiUrl: config.krokiUrl,
      cacheEntries: (countCached.get() as { n: number }).n,
      engines,
    };
  }

  const TEST_SOURCES: Record<EngineId, { language: string; source: string }> = {
    graphviz: { language: "dot", source: 'digraph G { rankdir=LR; alpha -> beta [label="test"] }' },
    plantuml: { language: "plantuml", source: "@startuml\nAlice -> Bob: test\n@enduml" },
    d2: { language: "d2", source: "alpha -> beta: test" },
  };

  bb.rpc.register(rpcContract, {
    render: (input) => render({ ...input, theme: input.theme ?? "light" }),
    status: () => status(),
    async engine_install({ engine }) {
      const config = await effective();
      const state = await resolveEngine(engine, config);
      if (state.available) return { started: false, path: state.path };
      if (engine === "graphviz") {
        throw new Error("Graphviz needs no install: the bundled WASM renderer draws it");
      }
      if (downloads.has(engine)) return { started: false, path: null };
      startDownload(engine);
      return { started: true, path: null };
    },
    async engine_remove({ engine }) {
      if (engine === "graphviz") return { removed: false };
      const home = engine === "plantuml" ? plantumlHome() : d2Home();
      const existed = existsSync(home);
      // Only ever delete a directory this plugin created.
      if (existed) await rm(home, { recursive: true, force: true });
      bb.realtime.publish(ENGINE_READY, { engine, removed: true });
      return { removed: existed };
    },
    async engine_set_path({ engine, path: value }) {
      const trimmed = value.trim();
      if (trimmed.length > 0 && !existsSync(trimmed)) {
        throw new Error(`nothing exists at ${trimmed}`);
      }
      if (trimmed.length > 0) {
        await chmod(trimmed, 0o755).catch(() => {
          // A binary that is already executable (or owned by another user) is fine.
        });
      }
      await settings.experimental_set({ [ENGINE_SETTING_KEYS[engine]]: trimmed });
      bb.realtime.publish(ENGINE_READY, { engine, path: trimmed || null });
      return { path: trimmed.length > 0 ? trimmed : null };
    },
    async engine_test({ engine }) {
      const config = await effective();
      const state = await resolveEngine(engine, config);
      const sample = TEST_SOURCES[engine];
      try {
        if (!state.available) {
          if (engine !== "graphviz") startDownload(engine);
          throw new Error(`${ENGINE_LABELS[engine]} is not installed`);
        }
        const result = await renderLocal(engine, sample.source, "light", config, state);
        return { ok: true, svg: result.svg };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    clear_cache() {
      const before = (countCached.get() as { n: number }).n;
      clearCached.run();
      return { removed: before };
    },
  });

  // Same render, reachable from the page for the file-preview content script.
  bb.http.route(
    "POST",
    "/render",
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as
        | { language?: unknown; source?: unknown; theme?: unknown }
        | null;
      if (!body || typeof body.language !== "string" || typeof body.source !== "string") {
        return context.json({ ok: false, error: "language and source are required" }, 400);
      }
      const theme = body.theme === "dark" ? "dark" : "light";
      try {
        const result = await render({ language: body.language, source: body.source, theme });
        return context.json({ ok: true, ...result });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return context.json({ ok: false, error: message }, 200);
      }
    },
    { auth: "local" },
  );

  bb.log.info(`diagram languages: ${DIAGRAM_LANGUAGES.length}`);
}
