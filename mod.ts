import type { SiteConfig, StenoPlugin } from "@steno/steno";
import { marked } from "marked";
import type { Token, Tokens, TokensList } from "marked";

/** Options accepted by this plugin. */
export interface PluginMarkdownExtensionsOptions {
  /** Converts straight quotes/dashes/ellipses to their typographic equivalents. Default `true`. */
  smartPunctuation?: boolean;
  /**
   * `"bottom"` moves `[^id]: ...` footnote definitions to a rendered section
   * at the end of the document and turns `[^id]` references into numbered,
   * linked markers. `"inline"` is an explicit no-op passthrough — footnote
   * syntax is left exactly as `marked` would otherwise leave it (literal
   * text, since `marked` has no built-in footnote support of its own) — kept
   * so a site can opt back out without removing the plugin. Default
   * `"bottom"`.
   */
  footnotes?: "bottom" | "inline";
  /**
   * Recognizes `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` /
   * `[!CAUTION]` blockquote prefixes and renders them as styled callouts.
   * Default `true`.
   */
  githubAlerts?: boolean;
  /**
   * Class appended to any `<a href>` whose host differs from `baseUrl` (or,
   * with no `baseUrl`, any absolute `http(s)` URL). `false` disables the
   * pass entirely. Default `"external"`.
   */
  externalLinkClass?: string | false;
  /**
   * The site's own base URL, used to tell "external" from "internal" links.
   * Unset means: any absolute `http://`/`https://` URL is external, any
   * relative URL is internal.
   */
  baseUrl?: string;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    PluginMarkdownExtensionsOptions,
    "smartPunctuation" | "footnotes" | "githubAlerts" | "externalLinkClass"
  >
> = {
  smartPunctuation: true,
  footnotes: "bottom",
  githubAlerts: true,
  externalLinkClass: "external",
};

/**
 * Validates plugin options, throwing a descriptive error for anything
 * malformed. Exported so a factory-time or `beforeBuild`-time check can
 * reuse it, and so it can be unit tested directly.
 *
 * @throws {Error} if any option has an invalid shape or value.
 */
export function validateOptions(
  options: PluginMarkdownExtensionsOptions,
): void {
  if (
    options.footnotes !== undefined && options.footnotes !== "bottom" &&
    options.footnotes !== "inline"
  ) {
    throw new Error(
      `markdown-extensions: "footnotes" must be "bottom" or "inline", got ${
        JSON.stringify(options.footnotes)
      }.`,
    );
  }
  if (
    options.externalLinkClass !== undefined &&
    options.externalLinkClass !== false &&
    typeof options.externalLinkClass !== "string"
  ) {
    throw new Error(
      `markdown-extensions: "externalLinkClass" must be a string or false, got ${typeof options
        .externalLinkClass}.`,
    );
  }
  if (options.externalLinkClass === "") {
    throw new Error(
      `markdown-extensions: "externalLinkClass" must not be an empty string — use false to disable.`,
    );
  }
  if (options.baseUrl !== undefined) {
    try {
      new URL(options.baseUrl);
    } catch {
      throw new Error(
        `markdown-extensions: "baseUrl" must be a valid absolute URL, got ${
          JSON.stringify(options.baseUrl)
        }.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared token-tree walking
// ---------------------------------------------------------------------------

/**
 * Returns every child token array a given token may hold, across all of
 * `marked`'s token kinds (`tokens`, list `items`, and table `header`/`rows`
 * cells). Used to walk the whole AST generically without hard-coding one
 * traversal per token kind.
 */
function childTokenArrays(token: Token): Token[][] {
  const arrays: Token[][] = [];
  const generic = token as unknown as Record<string, unknown>;
  if (Array.isArray(generic.tokens)) arrays.push(generic.tokens as Token[]);
  if (Array.isArray(generic.items)) arrays.push(generic.items as Token[]);
  if (token.type === "table") {
    const table = token as Tokens.Table;
    arrays.push(table.header as unknown as Token[]);
    for (const row of table.rows) arrays.push(row as unknown as Token[]);
  }
  return arrays;
}

// ---------------------------------------------------------------------------
// 1. Smart punctuation
// ---------------------------------------------------------------------------

const OPENING_DOUBLE = /(^|[\s([{<—–])"/g;
const OPENING_SINGLE = /(^|[\s([{<—–])'/g;

/**
 * Converts straight quotes/dashes/ellipses in a plain-text string to their
 * typographic equivalents (curly quotes, en/em dash, ellipsis). Idempotent —
 * text that's already typographic contains none of the straight characters
 * this looks for, so a second pass leaves it unchanged.
 *
 * This is a simplified, SmartyPants-style heuristic operating on one chunk
 * of text at a time (a single `marked` text token). It does not track quote
 * state across sibling tokens, so a quote that opens in one inline token
 * (e.g. before a `**bold**` span) and closes in the next is handled
 * per-token, not as a single logical span — each straight quote is judged
 * opening/closing from its own immediate surroundings.
 */
export function applySmartPunctuation(text: string): string {
  let out = text;

  // Em dash first (---), then en dash (--), so "---" doesn't leave a
  // dangling "-" behind after the en-dash pass consumes two of its dashes.
  out = out.replaceAll("---", "—");
  out = out.replaceAll("--", "–");

  // Ellipsis.
  out = out.replaceAll("...", "…");

  // Double quotes: opening when preceded by start-of-string/whitespace/open
  // bracket/dash, closing otherwise.
  out = out.replace(OPENING_DOUBLE, "$1“");
  out = out.replaceAll('"', "”");

  // Single quotes/apostrophes: same heuristic. This also correctly turns a
  // contraction apostrophe ("don't") into a closing curly quote, since it's
  // preceded by a letter, not whitespace/start.
  out = out.replace(OPENING_SINGLE, "$1‘");
  out = out.replaceAll("'", "’");

  return out;
}

/**
 * Walks a token tree in place, running {@link applySmartPunctuation} over
 * every plain-text token. Skips `code` and `codespan` tokens entirely so
 * code content is never rewritten. When a `text` token itself has nested
 * inline `tokens` (rare, but part of `marked`'s `Tokens.Text` shape),
 * recurses into those instead of touching the token's own `.text`, since
 * `marked`'s renderer prefers `.tokens` over `.text` when both are present.
 */
export function smartenTokens(tokens: Token[]): Token[] {
  for (const token of tokens) {
    if (token.type === "code" || token.type === "codespan") continue;

    if (token.type === "text") {
      const text = token as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) {
        smartenTokens(text.tokens);
      } else {
        text.text = applySmartPunctuation(text.text);
      }
      continue;
    }

    for (const children of childTokenArrays(token)) {
      smartenTokens(children);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 2. GitHub-style alerts
// ---------------------------------------------------------------------------

const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
type AlertType = (typeof ALERT_TYPES)[number];

const ALERT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i;

const ALERT_LABELS: Record<AlertType, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/**
 * Detects whether a blockquote token is a GitHub-style alert (`> [!NOTE]`
 * and friends), returning its type and the remaining body Markdown with the
 * marker line stripped off. Returns `null` for an ordinary blockquote, or a
 * malformed marker (unknown type, no matching `[!...]` at all) — those are
 * left completely alone by the caller.
 */
export function detectGithubAlert(
  blockquote: Tokens.Blockquote,
): { type: AlertType; bodyMarkdown: string } | null {
  const match = ALERT_MARKER_RE.exec(blockquote.text);
  if (!match) return null;
  const type = match[1].toLowerCase() as AlertType;
  return { type, bodyMarkdown: blockquote.text.slice(match[0].length) };
}

/**
 * Renders a detected alert's body Markdown to the final callout HTML. Class
 * names (`markdown-alert markdown-alert-<type>`) match Ametrine's own
 * `templates/shortcodes/alert.html` / `sass/components/_alerts.scss`, so a
 * theme carrying that CSS unchanged renders these identically — except the
 * title, which this plugin renders as a plain `<p class="markdown-alert-title">`
 * instead of Ametrine's CSS `::before` + inline `--alert-title`/`--alert-icon`
 * custom properties (those require a Tera-rendered icon + translated string
 * this plugin has no access to). Ametrine's `::before` rule only fires when
 * those custom properties are set inline, so the two titles don't double up.
 */
export function renderGithubAlertHtml(
  type: AlertType,
  bodyMarkdown: string,
  smartPunctuation: boolean,
): string {
  const source = smartPunctuation
    ? applySmartPunctuation(bodyMarkdown)
    : bodyMarkdown;
  const trimmed = source.trim();
  const bodyHtml = trimmed.length > 0
    ? marked.parser(marked.lexer(trimmed))
    : "";
  return `<div class="markdown-alert markdown-alert-${type}">\n` +
    `<p class="markdown-alert-title">${ALERT_LABELS[type]}</p>\n` +
    bodyHtml +
    `</div>\n`;
}

/**
 * Walks the token tree converting every GitHub-style alert blockquote into
 * an `html` token holding its rendered callout markup. Ordinary blockquotes,
 * and blockquotes with an unrecognized `[!...]` marker, are left untouched
 * and still recursed into (an alert can appear inside a list item or a
 * regular blockquote).
 */
export function transformGithubAlerts(
  tokens: Token[],
  smartPunctuation: boolean,
): Token[] {
  for (const token of tokens) {
    if (token.type === "blockquote") {
      const detected = detectGithubAlert(token as Tokens.Blockquote);
      if (detected) {
        const html = token as unknown as Tokens.HTML;
        html.type = "html";
        html.block = true;
        html.pre = false;
        html.text = renderGithubAlertHtml(
          detected.type,
          detected.bodyMarkdown,
          smartPunctuation,
        );
        html.raw = html.text;
        continue;
      }
    }
    for (const children of childTokenArrays(token)) {
      transformGithubAlerts(children, smartPunctuation);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 3. Footnotes
// ---------------------------------------------------------------------------

const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s*([\s\S]*)$/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;

/** Turns a footnote id into a value safe to use inside an HTML `id` attribute. */
function footnoteSlug(id: string): string {
  return id.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-");
}

/**
 * Parses a single top-level paragraph's text as a footnote definition
 * (`[^id]: body`), returning `null` when it isn't one. Only matches when the
 * marker starts the paragraph's full text — a mid-paragraph `[^id]:` is left
 * alone, since it's very unlikely to be an intentional footnote definition.
 */
export function parseFootnoteDefinition(
  paragraphText: string,
): { id: string; body: string } | null {
  const match = FOOTNOTE_DEF_RE.exec(paragraphText);
  if (!match) return null;
  return { id: match[1], body: match[2] };
}

/**
 * Moves `[^id]: ...` footnote definitions out of the document body and
 * appends a rendered footnotes section at the end, turning every `[^id]`
 * reference into a numbered, linked marker (`<sup>` + anchor).
 *
 * Deliberately conservative, given `marked` itself has no footnote syntax of
 * its own to fall back on:
 * - Only **top-level** paragraphs (not inside a list, blockquote, or table)
 *   are recognized as definitions.
 * - A definition is only removed and rendered when at least one matching
 *   `[^id]` reference exists elsewhere in the document — an orphaned
 *   `[^id]: ...`-shaped paragraph with no reference is left as ordinary text,
 *   since that's more likely a coincidence than an intended footnote.
 * - References are only replaced when a matching definition exists;
 *   unmatched `[^id]` text is left exactly as `marked` would already render
 *   it (literal text).
 */
export function transformFootnotesToBottom(
  tokens: Token[],
  smartPunctuation: boolean,
): Token[] {
  // Pass 1: collect top-level definitions.
  const definitions = new Map<string, string>();
  const definitionTokens = new Set<Token>();
  for (const token of tokens) {
    if (token.type !== "paragraph") continue;
    const parsed = parseFootnoteDefinition((token as Tokens.Paragraph).text);
    if (parsed) {
      definitions.set(parsed.id, parsed.body);
      definitionTokens.add(token);
    }
  }
  if (definitions.size === 0) return tokens;

  // Pass 2: replace references anywhere in the tree, tracking which
  // definitions were actually used and in what order they first appear.
  // Definition paragraphs themselves are skipped here — otherwise the
  // `[^id]` inside `[^id]: body` would count as a self-reference.
  const usedOrder: string[] = [];
  const seen = new Set<string>();

  function replaceInArray(array: Token[]): Token[] {
    const result: Token[] = [];
    for (const token of array) {
      if (definitionTokens.has(token)) {
        result.push(token);
        continue;
      }
      if (token.type === "text" && !(token as Tokens.Text).tokens) {
        const text = token as Tokens.Text;
        const pieces = splitFootnoteReferences(text.text);
        if (pieces.length === 1 && typeof pieces[0] === "string") {
          result.push(token);
          continue;
        }
        for (const piece of pieces) {
          if (typeof piece === "string") {
            if (piece.length > 0) {
              result.push(
                { type: "text", raw: piece, text: piece } as Tokens.Text,
              );
            }
          } else {
            if (!definitions.has(piece.id)) {
              // No matching definition — leave the bracket text literal.
              result.push(
                {
                  type: "text",
                  raw: piece.raw,
                  text: piece.raw,
                } as Tokens.Text,
              );
              continue;
            }
            if (!seen.has(piece.id)) {
              seen.add(piece.id);
              usedOrder.push(piece.id);
            }
            const number = usedOrder.indexOf(piece.id) + 1;
            const slug = footnoteSlug(piece.id);
            const refHtml =
              `<sup id="fnref-${slug}"><a href="#fn-${slug}" class="footnote-ref">[${number}]</a></sup>`;
            result.push(
              {
                type: "html",
                raw: refHtml,
                text: refHtml,
                block: false,
                pre: false,
              } as unknown as Tokens.HTML,
            );
          }
        }
        continue;
      }

      for (const children of childTokenArrays(token)) {
        const updated = replaceInArray(children);
        (token as unknown as Record<string, unknown>).tokens = updated;
      }
      result.push(token);
    }
    return result;
  }

  const withReferences = replaceInArray(tokens);
  if (usedOrder.length === 0) return tokens;

  // Pass 3: drop the now-consumed definition paragraphs from the top level.
  const withoutDefinitions = withReferences.filter((token) => {
    if (token.type !== "paragraph") return true;
    const parsed = parseFootnoteDefinition((token as Tokens.Paragraph).text);
    return !(parsed && usedOrder.includes(parsed.id));
  });

  // Pass 4: append the rendered footnotes section.
  const items = usedOrder.map((id) => {
    const slug = footnoteSlug(id);
    const body = definitions.get(id)!;
    const source = smartPunctuation ? applySmartPunctuation(body) : body;
    const bodyHtml = marked.parser(marked.lexer(source)).trim();
    return `<li id="fn-${slug}">${bodyHtml} <a href="#fnref-${slug}" class="footnote-backref">↩</a></li>`;
  });
  const sectionHtml = `<section class="footnotes">\n<ol>\n${
    items.join("\n")
  }\n</ol>\n</section>\n`;
  withoutDefinitions.push(
    {
      type: "html",
      raw: sectionHtml,
      text: sectionHtml,
      block: true,
      pre: false,
    } as unknown as Tokens.HTML,
  );

  return withoutDefinitions;
}

/** One literal run of text, or one recognized `[^id]` reference. */
type FootnotePiece = string | { id: string; raw: string };

/** Splits a text token's content on `[^id]` references, keeping literal runs between them. */
function splitFootnoteReferences(text: string): FootnotePiece[] {
  const pieces: FootnotePiece[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(FOOTNOTE_REF_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) pieces.push(text.slice(lastIndex, index));
    pieces.push({ id: match[1], raw: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) pieces.push(text.slice(lastIndex));
  if (pieces.length === 0) pieces.push(text);
  return pieces;
}

// ---------------------------------------------------------------------------
// 4. External link class
// ---------------------------------------------------------------------------

const ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CLASS_RE = /\bclass\s*=\s*"([^"]*)"/i;

/**
 * Decides whether an `href` points outside the site.
 *
 * - `mailto:`, `tel:`, and fragment-only (`#...`) links are always internal.
 * - With `baseUrl` set: resolves `href` against it and compares hosts.
 * - With no `baseUrl`: any absolute `http://`/`https://` URL is external,
 *   anything else (relative paths, protocol-relative `//host/path`, other
 *   schemes) is treated as internal.
 */
export function isExternalHref(href: string, baseUrl?: string): boolean {
  const trimmed = href.trim();
  if (
    trimmed === "" || trimmed.startsWith("#") || /^(mailto|tel):/i.test(trimmed)
  ) {
    return false;
  }

  if (baseUrl) {
    try {
      const resolved = new URL(trimmed, baseUrl);
      const base = new URL(baseUrl);
      return resolved.host !== base.host;
    } catch {
      // Unparsable as a URL even against a base — not something we can
      // confidently call external.
      return false;
    }
  }

  return /^https?:\/\//i.test(trimmed);
}

/** Adds `className` to a single `<a ...>` opening tag's `class` attribute, merging with any existing one. */
export function addClassToAnchorTag(tag: string, className: string): string {
  const classMatch = CLASS_RE.exec(tag);
  if (!classMatch) {
    return tag.replace(/^<a\b/i, `<a class="${className}"`);
  }
  const existing = classMatch[1].split(/\s+/).filter(Boolean);
  if (existing.includes(className)) return tag;
  const merged = [...existing, className].join(" ");
  return tag.slice(0, classMatch.index) +
    tag.slice(classMatch.index).replace(CLASS_RE, `class="${merged}"`);
}

/**
 * Adds `className` to every `<a href="...">` in `html` whose destination is
 * external, per {@link isExternalHref}. Anchors with no `href` (bare id
 * targets) are left untouched.
 */
export function applyExternalLinkClass(
  html: string,
  className: string,
  baseUrl?: string,
): string {
  return html.replace(ANCHOR_TAG_RE, (tag) => {
    const hrefMatch = HREF_RE.exec(tag);
    if (!hrefMatch) return tag;
    const href = hrefMatch[1] ?? hrefMatch[2] ?? "";
    if (!isExternalHref(href, baseUrl)) return tag;
    return addClassToAnchorTag(tag, className);
  });
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates the plugin-markdown-extensions plugin: smart punctuation,
 * bottom-of-page footnotes, GitHub-style alert callouts, and an automatic
 * class on external links — see the README for the full behavior of each.
 *
 * Registered in a site's config.yml:
 *
 * ```yaml
 * plugins:
 *   - package: jsr:@you/plugin-markdown-extensions
 *     options:
 *       smartPunctuation: true
 *       footnotes: bottom
 *       githubAlerts: true
 *       externalLinkClass: external
 * ```
 */
export default function pluginMarkdownExtensions(
  options: PluginMarkdownExtensionsOptions = {},
): StenoPlugin {
  const smartPunctuation = options.smartPunctuation ??
    DEFAULT_OPTIONS.smartPunctuation;
  const footnotes = options.footnotes ?? DEFAULT_OPTIONS.footnotes;
  const githubAlerts = options.githubAlerts ?? DEFAULT_OPTIONS.githubAlerts;
  const externalLinkClass = options.externalLinkClass ??
    DEFAULT_OPTIONS.externalLinkClass;
  const baseUrl = options.baseUrl;

  return {
    name: "plugin-markdown-extensions",

    // Runs once before the build starts — good place to validate options.
    beforeBuild(_config: SiteConfig) {
      validateOptions(options);
    },

    transformAst(tokens) {
      let working: Token[] = tokens as unknown as Token[];

      if (githubAlerts) {
        working = transformGithubAlerts(working, smartPunctuation);
      }
      if (footnotes === "bottom") {
        working = transformFootnotesToBottom(working, smartPunctuation);
      }
      if (smartPunctuation) {
        working = smartenTokens(working);
      }

      const result = working as unknown as TokensList;
      result.links = (tokens as unknown as TokensList).links;
      return result as unknown as typeof tokens;
    },

    // Transforms every page's rendered HTML. Must return a string — an
    // unvalidated non-string return here fails later in the build with no
    // reference back to this plugin, so keep this one honest.
    transformHtml(html) {
      if (externalLinkClass === false) return html;
      return applyExternalLinkClass(html, externalLinkClass, baseUrl);
    },
  };
}
