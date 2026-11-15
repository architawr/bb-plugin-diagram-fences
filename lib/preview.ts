/**
 * Content script: draw diagram fences in BB's Markdown file preview.
 *
 * BB's code-fence renderer slot only reaches assistant messages, so file
 * previews keep the raw fence. This script walks the preview DOM, hides each
 * diagram code block, and inserts the SVG our server draws next to it. It never
 * edits React-owned children: it only adds attributes and one sibling <figure>,
 * so a re-render of the preview is harmless — the observer simply draws again.
 *
 * Cost control:
 *   - only mutations inside a preview panel schedule a scan;
 *   - a diagram is fetched when it is within 300 px of the viewport, never for
 *     a preview that is hidden or scrolled far away;
 *   - rendered SVG and in-flight requests are kept per key, so a re-render,
 *     a tab switch or a theme flip back does not ask the server again.
 */
import { fingerprint } from "./hash";
import { isDiagramLanguage, normalizeLanguage } from "./languages";

const FIGURE_ATTR = "data-bb-diagram-figure";
const CARD_ATTR = "data-bb-diagram-card";
const STYLE_ID = "bb-diagram-fences-style";
const PREVIEW_ROOT = "[data-file-preview-scroll-container]";
const CACHE_LIMIT = 60;

const STYLE = `
${PREVIEW_ROOT} [${CARD_ATTR}] { display: none !important; }
.bb-diagram-figure {
  margin: 0.75rem 0;
  overflow: hidden;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 6px;
  background: var(--surface-recessed, transparent);
}
.bb-diagram-figure-header {
  padding: 6px 12px 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-foreground, #8b8b95);
}
.bb-diagram-figure-status {
  padding: 8px 12px 12px;
  font-size: 12px;
  color: var(--muted-foreground, #8b8b95);
}
.bb-diagram-figure-error {
  padding: 8px 12px 12px;
  font-size: 12px;
  color: var(--destructive, #d14a4a);
}
.bb-diagram-figure-image {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
  padding: 0 12px 12px;
}
`;

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function languageOf(code: Element): string | null {
  for (const className of code.classList) {
    if (!className.startsWith("language-")) continue;
    const language = normalizeLanguage(className.slice("language-".length));
    return isDiagramLanguage(language) ? language : null;
  }
  return null;
}

export function mountPreviewDiagrams(pluginId: string, signal: AbortSignal): () => void {
  const endpoint = `/api/v1/plugins/${pluginId}/http/render`;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);

  const svgCache = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();
  const objectUrls = new Set<string>();
  const figures = new Set<HTMLElement>();
  const cards = new Set<HTMLElement>();
  const watched = new WeakSet<HTMLElement>();
  let timer: number | null = null;
  let disposed = false;

  function remember(key: string, svg: string) {
    svgCache.delete(key);
    svgCache.set(key, svg);
    while (svgCache.size > CACHE_LIMIT) {
      const oldest = svgCache.keys().next().value;
      if (oldest === undefined) break;
      svgCache.delete(oldest);
    }
  }

  async function svgFor(
    key: string,
    language: string,
    source: string,
    theme: string,
  ): Promise<string> {
    const cached = svgCache.get(key);
    if (cached !== undefined) {
      remember(key, cached);
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const job = (async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language, source, theme }),
        signal,
      });
      const payload = (await response.json()) as
        | { ok: true; svg: string }
        | { ok: false; error?: string };
      if (!payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      remember(key, payload.svg);
      return payload.svg;
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, job);
    return job;
  }

  function hideCard(card: HTMLElement) {
    if (card === document.body) return;
    if (card.querySelectorAll("pre").length !== 1) return;
    card.setAttribute(CARD_ATTR, "");
    cards.add(card);
  }

  function showCard(card: HTMLElement) {
    card.removeAttribute(CARD_ATTR);
    cards.delete(card);
  }

  async function draw(pre: HTMLElement) {
    const code = pre.firstElementChild;
    if (!(code instanceof HTMLElement)) return;
    const language = languageOf(code);
    if (language === null) return;
    const source = code.textContent ?? "";
    if (source.trim().length === 0) return;
    const theme = isDark() ? "dark" : "light";
    const key = `${language}:${theme}:${fingerprint(source)}`;

    // BB wraps a fence in a card (language label, copy, then <pre>). Replace the
    // whole card when it looks like one, otherwise just follow the <pre>.
    const parent = pre.parentElement;
    const looksLikeCard =
      parent !== null &&
      (parent.className.includes("rounded") || parent.className.includes("border"));
    const card =
      parent !== null && looksLikeCard && parent.children.length <= 4 ? parent : null;
    const host = card ?? pre;

    const existing = host.nextElementSibling;
    if (existing instanceof HTMLElement && existing.getAttribute(FIGURE_ATTR) === key) return;
    if (existing instanceof HTMLElement && existing.hasAttribute(FIGURE_ATTR)) {
      existing.remove();
      figures.delete(existing);
    }

    const figure = document.createElement("figure");
    figure.setAttribute(FIGURE_ATTR, key);
    figure.className = "bb-diagram-figure";

    const header = document.createElement("div");
    header.className = "bb-diagram-figure-header";
    header.textContent = language;

    const status = document.createElement("div");
    status.className = "bb-diagram-figure-status";
    status.textContent = svgCache.has(key) ? "Drawing…" : "Rendering diagram…";

    const image = document.createElement("img");
    image.className = "bb-diagram-figure-image";
    image.alt = `${language} diagram`;

    figure.append(header, status, image);
    host.after(figure);
    figures.add(figure);

    if (card !== null) hideCard(card);

    try {
      const svg = await svgFor(key, language, source, theme);
      if (disposed || !figure.isConnected) return;
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      objectUrls.add(url);
      image.src = url;
      status.remove();
    } catch (cause) {
      if (disposed) return;
      figure.remove();
      figures.delete(figure);
      if (card !== null) showCard(card);
      if (signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      // Leave BB's own code block in place; only note why nothing was drawn.
      const note = document.createElement("div");
      note.className = "bb-diagram-figure-error";
      note.textContent = `${language}: ${message}`;
      host.after(note);
      window.setTimeout(() => note.remove(), 8000);
    }
  }

  /** Fetch only when the fence is close to the viewport. */
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pre = entry.target as HTMLElement;
        lazy.unobserve(pre);
        void draw(pre);
      }
    },
    { rootMargin: "300px 0px" },
  );

  function scan() {
    if (disposed) return;
    for (const root of document.querySelectorAll<HTMLElement>(PREVIEW_ROOT)) {
      for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
        if (watched.has(pre)) continue;
        watched.add(pre);
        if (languageOf(pre.firstElementChild ?? pre) === null) continue;
        lazy.observe(pre);
      }
    }
  }

  function schedule() {
    if (disposed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      scan();
    }, 120);
  }

  function touchesPreview(record: MutationRecord): boolean {
    const target = record.target;
    if (target instanceof Element && target.closest(PREVIEW_ROOT) !== null) return true;
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches(PREVIEW_ROOT) ||
        node.querySelector(PREVIEW_ROOT) !== null ||
        node.closest(PREVIEW_ROOT) !== null
      ) {
        return true;
      }
    }
    return false;
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (touchesPreview(record)) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const themeObserver = new MutationObserver(() => schedule());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  scan();

  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    observer.disconnect();
    themeObserver.disconnect();
    lazy.disconnect();
    for (const figure of figures) figure.remove();
    for (const card of cards) card.removeAttribute(CARD_ATTR);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    figures.clear();
    cards.clear();
    objectUrls.clear();
    svgCache.clear();
    inFlight.clear();
    style.remove();
  };
}
