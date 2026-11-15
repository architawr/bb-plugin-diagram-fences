// bb-plugin-diagram-fences — backend.
//
// Draws fenced PlantUML, Graphviz/dot, D2 and the rest of the Kroki family in
// assistant replies (and, through the content script in app.tsx, in Markdown
// file previews). Three rendering routes, picked in Settings:
//
//   auto   — a local engine when this machine has one, kroki.io otherwise
//   local  — only this machine; an unsupported language is an error, and so is
//            a missing engine
//   kroki  — the public kroki.io service, nothing runs locally
//   custom — a self-hosted Kroki (or any compatible gateway)
//
// Local engines never stay running: graphviz is either `dot` spawned per
// diagram or a lazily created WASM instance, PlantUML is a native binary that
// exits after one render, and D2 uses the `d2` binary when it is installed.
// Every SVG is cached by content hash, so a diagram is drawn once per machine.
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

/** PlantUML publishes native (GraalVM) builds — no Java runtime needed. */
const NATIVE_ASSETS: Record<string, string> = {
  "darwin-arm64": "native-plantuml-macos-arm64",
  "linux-x64": "native-plantuml-linux-amd64",
  "linux-arm64": "native-plantuml-linux-arm64",
  "win32-x64": "native-plantuml-windows-amd64",
};

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_CACHED_SVG_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const KROKI_TIMEOUT_MS = 20_000;
const ENGINE_READY = "engine-ready";

const themeSchema = z.enum(["light", "dark"]);

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
          id: z.string(),
          label: z.string(),
          available: z.boolean(),
          detail: z.string(),
        }),
      ),
    }),
  },
  download_plantuml: {
    input: z.null(),
    output: z.object({ started: z.boolean(), path: z.string().nullable() }),
  },
  clear_cache: {
    input: z.null(),
    output: z.object({ removed: z.number() }),
  },
});

type Theme = z.infer<typeof themeSchema>;

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

interface CachedDiagram {
  svg: string;
  engine: string;
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
    downloadPlantUml: {
      type: "boolean",
      label: "Download the PlantUML engine when a diagram needs it",
      default: true,
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

  function cacheLookup(hash: string): CachedDiagram | null {
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
      downloadPlantUml: values.downloadPlantUml,
      cacheEntries: values.cacheEntries,
      maxSourceKb: values.maxSourceKb,
    };
  }

  // ---------------------------------------------------------------- engines

  async function renderGraphviz(source: string, theme: Theme): Promise<{ svg: string; engine: string }> {
    const dot = await findExecutable("dot");
    if (dot) {
      const svg = await runProcess(dot, ["-Tsvg"], source);
      return { svg: theme === "dark" ? recolorGraphviz(svg) : svg, engine: "graphviz-dot" };
    }
    const viz = await vizInstance();
    const svg = viz.renderString(source, { format: "svg" });
    return { svg: theme === "dark" ? recolorGraphviz(svg) : svg, engine: "graphviz-wasm" };
  }

  let plantumlDownload: Promise<string | null> | null = null;
  let plantumlPath: string | null = null;

  function engineDirectory(): string {
    // <dataDir>/plugins/<id>/ is this plugin's own directory (data.db lives there).
    return path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "engines",
      `plantuml-${PLANTUML_VERSION}`,
    );
  }

  function cachedPlantumlBinary(): string | null {
    if (plantumlPath && existsSync(plantumlPath)) return plantumlPath;
    const candidate = path.join(
      engineDirectory(),
      process.platform === "win32" ? "plantuml.exe" : "plantuml",
    );
    if (existsSync(candidate)) {
      plantumlPath = candidate;
      return candidate;
    }
    return null;
  }

  async function downloadPlantuml(): Promise<string | null> {
    const asset = NATIVE_ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) {
      bb.log.warn(`no native PlantUML build for ${process.platform}-${process.arch}`);
      return null;
    }
    const directory = engineDirectory();
    const zipPath = path.join(directory, "plantuml.zip");
    const url = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/${asset}-${PLANTUML_VERSION}.zip`;
    bb.log.info(`downloading PlantUML ${PLANTUML_VERSION} (${asset})`);
    await mkdir(directory, { recursive: true });
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`PlantUML download failed: HTTP ${response.status}`);
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    try {
      await runProcess("unzip", ["-o", "-q", zipPath, "-d", directory], "", 120_000);
    } catch (cause) {
      // macOS keeps `unzip`, but ditto is the fallback when it is missing.
      await runProcess("ditto", ["-x", "-k", zipPath, directory], "", 120_000).catch(() => {
        throw cause;
      });
    }
    const binary = path.join(
      directory,
      process.platform === "win32" ? "plantuml.exe" : "plantuml",
    );
    await chmod(binary, 0o755);
    await rm(zipPath, { force: true });
    plantumlPath = binary;
    bb.log.info(`PlantUML engine ready at ${binary}`);
    bb.realtime.publish(ENGINE_READY, { engine: "plantuml" });
    return binary;
  }

  function startPlantumlDownload(): void {
    plantumlDownload ??= downloadPlantuml()
      .catch((cause: unknown) => {
        bb.log.warn(
          `PlantUML download failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        plantumlDownload = null;
        return null;
      })
      .finally(() => {
        plantumlDownload = null;
      });
  }

  async function findPlantuml(): Promise<string | null> {
    const cached = cachedPlantumlBinary();
    if (cached) return cached;
    const installed = await findExecutable("plantuml");
    if (installed) return installed;
    return null;
  }

  async function renderPlantuml(source: string, theme: Theme): Promise<{ svg: string; engine: string }> {
    const binary = await findPlantuml();
    if (!binary) throw new Error("the PlantUML engine is not available on this machine");
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

  async function renderD2(source: string, theme: Theme): Promise<{ svg: string; engine: string }> {
    const binary = await findExecutable("d2");
    if (!binary) throw new Error("the d2 binary is not installed");
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
      const detail = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
      throw new Error(`Kroki HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return { svg: await response.text(), engine: "kroki" };
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

      if (wantsLocal && local === "graphviz") {
        return renderGraphviz(source, input.theme);
      }
      if (wantsLocal && local === "plantuml") {
        const binary = await findPlantuml();
        if (binary) return renderPlantuml(source, input.theme);
        if (config.downloadPlantUml && config.mode !== "local") startPlantumlDownload();
        if (config.mode === "local") {
          if (config.downloadPlantUml) {
            startPlantumlDownload();
            throw new Error(
              "the PlantUML engine is downloading; the diagram appears on the next message",
            );
          }
          throw new Error("the PlantUML engine is not installed and downloading is off");
        }
      }
      if (wantsLocal && local === "d2") {
        const binary = await findExecutable("d2");
        if (binary) return renderD2(source, input.theme);
        if (config.mode === "local") throw new Error("the d2 binary is not installed");
      }
      if (config.mode === "local") {
        throw new Error(
          local === null
            ? `no local engine draws ${language}; use Auto or kroki.io`
            : `the local ${local} engine is not available on this machine`,
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
    const [dot, plantumlBinary, d2, cached] = await Promise.all([
      findExecutable("dot"),
      findPlantuml(),
      findExecutable("d2"),
      Promise.resolve(cachedPlantumlBinary()),
    ]);
    return {
      mode: config.mode,
      krokiUrl: config.krokiUrl,
      cacheEntries: (countCached.get() as { n: number }).n,
      engines: [
        {
          id: "graphviz",
          label: "Graphviz",
          available: true,
          detail: dot ? `dot at ${dot}` : vizPromise ? "WASM" : "WASM (loads on first diagram)",
        },
        {
          id: "plantuml",
          label: "PlantUML",
          available: plantumlBinary !== null,
          detail: cached
            ? "native engine downloaded"
            : plantumlBinary
              ? `plantuml at ${plantumlBinary}`
              : plantumlDownload
                ? "downloading…"
                : config.downloadPlantUml
                  ? "downloads on first diagram"
                  : "not installed",
        },
        {
          id: "d2",
          label: "D2",
          available: d2 !== null,
          detail: d2 ? `d2 at ${d2}` : "not installed — D2 goes to Kroki",
        },
      ],
    };
  }

  bb.rpc.register(rpcContract, {
    render: (input) => render({ ...input, theme: input.theme ?? "light" }),
    status: () => status(),
    async download_plantuml() {
      const config = await effective();
      if (!config.downloadPlantUml) throw new Error("downloading is turned off in settings");
      const existing = cachedPlantumlBinary();
      if (existing) return { started: false, path: existing };
      if (plantumlDownload) return { started: false, path: null };
      startPlantumlDownload();
      return { started: true, path: null };
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
