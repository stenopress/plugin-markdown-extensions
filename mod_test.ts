import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { marked } from "marked";
import type { TokensList } from "marked";
import createPlugin, {
  addClassToAnchorTag,
  applyExternalLinkClass,
  applySmartPunctuation,
  detectGithubAlert,
  isExternalHref,
  parseFootnoteDefinition,
  renderGithubAlertHtml,
  smartenTokens,
  transformFootnotesToBottom,
  transformGithubAlerts,
  validateOptions,
} from "./mod.ts";

function lex(markdown: string): TokensList {
  return marked.lexer(markdown);
}

// ---------------------------------------------------------------------------
// Plugin shape / defaults
// ---------------------------------------------------------------------------

Deno.test("plugin-markdown-extensions: has a stable name", () => {
  const plugin = createPlugin();
  assertEquals(plugin.name, "plugin-markdown-extensions");
});

Deno.test("plugin-markdown-extensions: transformAst returns a real array", async () => {
  const plugin = createPlugin();
  const tokens = lex('Hello "world".');
  const result = await plugin.transformAst?.(tokens);
  assertEquals(Array.isArray(result), true);
});

Deno.test("plugin-markdown-extensions: transformAst preserves the links map", async () => {
  const plugin = createPlugin();
  const tokens = lex('A [ref link][1].\n\n[1]: https://example.com "Title"\n');
  const result = await plugin.transformAst?.(tokens) as TokensList;
  assertEquals(result.links["1"].href, "https://example.com");
});

Deno.test("plugin-markdown-extensions: transformHtml returns a string", async () => {
  const plugin = createPlugin();
  const result = await plugin.transformHtml?.("<p>hello</p>");
  assertEquals(typeof result, "string");
});

Deno.test("plugin-markdown-extensions: full pipeline renders smart punctuation, alerts, and footnotes together", async () => {
  const plugin = createPlugin();
  const source =
    'It\'s a "test"[^1].\n\n> [!NOTE]\n> Heads up.\n\n[^1]: A note -- with detail.\n';
  const tokens = lex(source);
  const transformed = await plugin.transformAst?.(tokens) as TokensList;
  const html = marked.parser(transformed);
  assertStringIncludes(html, "It’s a “test”");
  assertStringIncludes(html, "markdown-alert-note");
  assertStringIncludes(html, "footnote-ref");
  assertStringIncludes(html, "A note – with detail");
});

// ---------------------------------------------------------------------------
// validateOptions
// ---------------------------------------------------------------------------

Deno.test("validateOptions: accepts empty options", () => {
  validateOptions({});
});

Deno.test("validateOptions: rejects an invalid footnotes value", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => validateOptions({ footnotes: "top" as any }),
    Error,
    "footnotes",
  );
});

Deno.test("validateOptions: rejects a non-string, non-false externalLinkClass", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => validateOptions({ externalLinkClass: 5 as any }),
    Error,
    "externalLinkClass",
  );
});

Deno.test("validateOptions: rejects an empty-string externalLinkClass", () => {
  assertThrows(
    () => validateOptions({ externalLinkClass: "" }),
    Error,
    "empty string",
  );
});

Deno.test("validateOptions: accepts externalLinkClass: false", () => {
  validateOptions({ externalLinkClass: false });
});

Deno.test("validateOptions: rejects an invalid baseUrl", () => {
  assertThrows(
    () => validateOptions({ baseUrl: "not a url" }),
    Error,
    "baseUrl",
  );
});

Deno.test("plugin-markdown-extensions: beforeBuild throws on bad options", () => {
  // deno-lint-ignore no-explicit-any
  const plugin = createPlugin({ footnotes: "sideways" as any });
  assertThrows(() =>
    plugin.beforeBuild?.({ title: "", description: "", author: "" })
  );
});

// ---------------------------------------------------------------------------
// 1. Smart punctuation
// ---------------------------------------------------------------------------

Deno.test("applySmartPunctuation: converts straight double quotes", () => {
  assertEquals(applySmartPunctuation('Say "hello" now'), "Say “hello” now");
});

Deno.test("applySmartPunctuation: converts straight single quotes / apostrophes", () => {
  assertEquals(applySmartPunctuation("It's 'quoted'"), "It’s ‘quoted’");
});

Deno.test("applySmartPunctuation: converts double and triple dashes", () => {
  assertEquals(applySmartPunctuation("a--b and a---b"), "a–b and a—b");
});

Deno.test("applySmartPunctuation: converts ellipses", () => {
  assertEquals(applySmartPunctuation("wait..."), "wait…");
});

Deno.test("applySmartPunctuation: is idempotent on already-curly text", () => {
  const curly = "“already” curly ‘quotes’ and an — em dash and a … ellipsis";
  assertEquals(applySmartPunctuation(curly), curly);
});

Deno.test("smartenTokens: rewrites a paragraph's text token", () => {
  const tokens = lex('She said "hi".');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "“hi”");
});

Deno.test("smartenTokens: does not touch inline code spans", () => {
  const tokens = lex('Use `"raw"` here.');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "<code>&quot;raw&quot;</code>");
});

Deno.test("smartenTokens: does not touch fenced code blocks", () => {
  const tokens = lex('```\nconst x = "raw";\n```\n');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "const x = &quot;raw&quot;;");
});

Deno.test("smartenTokens: reaches text nested inside emphasis/strong", () => {
  const tokens = lex('This is **"bold"** text.');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "“bold”");
});

Deno.test("smartenTokens: reaches text inside list items", () => {
  const tokens = lex('- It\'s a list\n- "Second" item\n');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "It’s a list");
  assertStringIncludes(html, "“Second” item");
});

Deno.test("smartenTokens: reaches text inside table cells", () => {
  const tokens = lex('| A | B |\n|---|---|\n| "x" | y\'s |\n');
  smartenTokens(tokens);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "“x”");
  assertStringIncludes(html, "y’s");
});

Deno.test("plugin-markdown-extensions: smartPunctuation: false disables the pass", async () => {
  const plugin = createPlugin({
    smartPunctuation: false,
    githubAlerts: false,
    footnotes: "inline",
  });
  const tokens = lex('Say "hello".');
  const transformed = await plugin.transformAst?.(tokens) as TokensList;
  const html = marked.parser(transformed);
  assertStringIncludes(html, "&quot;hello&quot;");
});

// ---------------------------------------------------------------------------
// 2. GitHub alerts
// ---------------------------------------------------------------------------

Deno.test("detectGithubAlert: recognizes a NOTE marker", () => {
  const tokens = lex("> [!NOTE]\n> Heads up.\n");
  const blockquote = tokens[0] as unknown as import("marked").Tokens.Blockquote;
  const detected = detectGithubAlert(blockquote);
  assertEquals(detected?.type, "note");
  assertEquals(detected?.bodyMarkdown.trim(), "Heads up.");
});

Deno.test("detectGithubAlert: is case-insensitive on the marker", () => {
  const tokens = lex("> [!warning]\n> careful\n");
  const blockquote = tokens[0] as unknown as import("marked").Tokens.Blockquote;
  assertEquals(detectGithubAlert(blockquote)?.type, "warning");
});

Deno.test("detectGithubAlert: returns null for an ordinary blockquote", () => {
  const tokens = lex("> Just a quote.\n");
  const blockquote = tokens[0] as unknown as import("marked").Tokens.Blockquote;
  assertEquals(detectGithubAlert(blockquote), null);
});

Deno.test("detectGithubAlert: returns null for an unrecognized marker", () => {
  const tokens = lex("> [!BOGUS]\n> nope\n");
  const blockquote = tokens[0] as unknown as import("marked").Tokens.Blockquote;
  assertEquals(detectGithubAlert(blockquote), null);
});

Deno.test("renderGithubAlertHtml: renders title and body classes", () => {
  const html = renderGithubAlertHtml("tip", "Some *body* text.", false);
  assertStringIncludes(html, 'class="markdown-alert markdown-alert-tip"');
  assertStringIncludes(html, 'class="markdown-alert-title"');
  assertStringIncludes(html, "Tip");
  assertStringIncludes(html, "<em>body</em>");
});

Deno.test("renderGithubAlertHtml: applies smart punctuation to the body when enabled", () => {
  const html = renderGithubAlertHtml("note", '"quoted" body', true);
  assertStringIncludes(html, "“quoted”");
});

Deno.test("transformGithubAlerts: converts a top-level alert blockquote to html", () => {
  const tokens = lex("> [!IMPORTANT]\n> Read this.\n");
  transformGithubAlerts(tokens, false);
  assertEquals(tokens[0].type, "html");
  const html = marked.parser(tokens);
  assertStringIncludes(html, "markdown-alert-important");
  assertStringIncludes(html, "Read this.");
});

Deno.test("transformGithubAlerts: leaves a malformed alert as a regular blockquote", () => {
  const tokens = lex("> [!NOPE] not a real type\n> body\n");
  transformGithubAlerts(tokens, false);
  assertEquals(tokens[0].type, "blockquote");
});

Deno.test("transformGithubAlerts: leaves an ordinary blockquote untouched", () => {
  const tokens = lex("> Just quoting someone.\n");
  transformGithubAlerts(tokens, false);
  assertEquals(tokens[0].type, "blockquote");
  const html = marked.parser(tokens);
  assertStringIncludes(html, "<blockquote>");
});

Deno.test("transformGithubAlerts: finds an alert nested inside a list item", () => {
  const tokens = lex("- item one\n  > [!TIP]\n  > nested tip\n");
  transformGithubAlerts(tokens, false);
  const html = marked.parser(tokens);
  assertStringIncludes(html, "markdown-alert-tip");
});

Deno.test("plugin-markdown-extensions: githubAlerts: false disables the pass", async () => {
  const plugin = createPlugin({ githubAlerts: false, footnotes: "inline" });
  const tokens = lex("> [!NOTE]\n> Heads up.\n");
  const transformed = await plugin.transformAst?.(tokens) as TokensList;
  assertEquals(transformed[0].type, "blockquote");
});

// ---------------------------------------------------------------------------
// 3. Footnotes
// ---------------------------------------------------------------------------

Deno.test("parseFootnoteDefinition: parses a simple definition", () => {
  const result = parseFootnoteDefinition("[^1]: The note body.");
  assertEquals(result, { id: "1", body: "The note body." });
});

Deno.test("parseFootnoteDefinition: returns null for non-definition text", () => {
  assertEquals(parseFootnoteDefinition("Just a paragraph."), null);
});

Deno.test("parseFootnoteDefinition: returns null when the marker isn't at the very start", () => {
  assertEquals(
    parseFootnoteDefinition("See [^1]: not actually a definition"),
    null,
  );
});

Deno.test("transformFootnotesToBottom: moves a referenced definition to the end and links the reference", () => {
  const tokens = lex("Body text[^1].\n\n[^1]: The footnote body.\n");
  const result = transformFootnotesToBottom(tokens, false);
  const html = marked.parser(result);
  assertStringIncludes(html, 'class="footnote-ref"');
  assertStringIncludes(html, 'class="footnotes"');
  assertStringIncludes(html, "The footnote body.");
  // The definition paragraph itself should no longer render as plain text.
  assertEquals(html.includes("[^1]: The footnote body."), false);
});

Deno.test("transformFootnotesToBottom: numbers references in order of first appearance", () => {
  const tokens = lex(
    "First[^b] then second[^a].\n\n[^a]: Definition A.\n\n[^b]: Definition B.\n",
  );
  const result = transformFootnotesToBottom(tokens, false);
  const html = marked.parser(result);
  const refB = html.indexOf("[1]");
  const refA = html.indexOf("[2]");
  assertEquals(refB > -1 && refA > refB, true);
});

Deno.test("transformFootnotesToBottom: leaves an unreferenced definition-shaped paragraph alone", () => {
  const tokens = lex("Just some text.\n\n[^orphan]: Nobody points at me.\n");
  const result = transformFootnotesToBottom(tokens, false);
  const html = marked.parser(result);
  assertStringIncludes(html, "[^orphan]: Nobody points at me.");
});

Deno.test("transformFootnotesToBottom: leaves an unmatched [^id] reference as literal text", () => {
  const tokens = lex("This has a stray[^missing] reference.\n");
  const result = transformFootnotesToBottom(tokens, false);
  const html = marked.parser(result);
  assertStringIncludes(html, "[^missing]");
});

Deno.test("transformFootnotesToBottom: is a no-op when there are no definitions", () => {
  const tokens = lex("Plain text with no footnotes at all.\n");
  const result = transformFootnotesToBottom(tokens, false);
  assertEquals(result, tokens);
});

Deno.test("plugin-markdown-extensions: footnotes: inline is a no-op passthrough", async () => {
  const plugin = createPlugin({
    footnotes: "inline",
    githubAlerts: false,
    smartPunctuation: false,
  });
  const tokens = lex("Body[^1].\n\n[^1]: The note body.\n");
  const transformed = await plugin.transformAst?.(tokens) as TokensList;
  const html = marked.parser(transformed);
  assertStringIncludes(html, "[^1]");
  assertEquals(html.includes('class="footnotes"'), false);
});

// ---------------------------------------------------------------------------
// 4. External link class
// ---------------------------------------------------------------------------

Deno.test("isExternalHref: absolute http(s) URL is external with no baseUrl", () => {
  assertEquals(isExternalHref("https://example.com/page"), true);
  assertEquals(isExternalHref("http://example.com/page"), true);
});

Deno.test("isExternalHref: relative URL is internal with no baseUrl", () => {
  assertEquals(isExternalHref("/about"), false);
  assertEquals(isExternalHref("about.html"), false);
});

Deno.test("isExternalHref: fragment, mailto, and tel links are always internal", () => {
  assertEquals(isExternalHref("#section"), false);
  assertEquals(isExternalHref("mailto:a@example.com"), false);
  assertEquals(isExternalHref("tel:+15551234567"), false);
});

Deno.test("isExternalHref: same host as baseUrl is internal", () => {
  assertEquals(
    isExternalHref("https://example.com/blog", "https://example.com"),
    false,
  );
  assertEquals(isExternalHref("/blog", "https://example.com"), false);
});

Deno.test("isExternalHref: different host than baseUrl is external", () => {
  assertEquals(
    isExternalHref("https://other.com/x", "https://example.com"),
    true,
  );
});

Deno.test("addClassToAnchorTag: adds a class attribute when none exists", () => {
  assertEquals(
    addClassToAnchorTag('<a href="https://x.com">', "external"),
    '<a class="external" href="https://x.com">',
  );
});

Deno.test("addClassToAnchorTag: merges into an existing class attribute", () => {
  assertEquals(
    addClassToAnchorTag('<a class="btn" href="https://x.com">', "external"),
    '<a class="btn external" href="https://x.com">',
  );
});

Deno.test("addClassToAnchorTag: does not duplicate an already-present class", () => {
  assertEquals(
    addClassToAnchorTag(
      '<a class="btn external" href="https://x.com">',
      "external",
    ),
    '<a class="btn external" href="https://x.com">',
  );
});

Deno.test("applyExternalLinkClass: classes an external link and leaves an internal one alone", () => {
  const html = applyExternalLinkClass(
    '<a href="https://other.com">out</a> <a href="/local">in</a>',
    "external",
  );
  assertMatch(html, /<a class="external" href="https:\/\/other\.com">out<\/a>/);
  assertStringIncludes(html, '<a href="/local">in</a>');
});

Deno.test("applyExternalLinkClass: respects baseUrl for host comparison", () => {
  const html = applyExternalLinkClass(
    '<a href="https://example.com/page">a</a> <a href="https://other.com/page">b</a>',
    "external",
    "https://example.com",
  );
  assertStringIncludes(html, '<a href="https://example.com/page">a</a>');
  assertMatch(
    html,
    /<a class="external" href="https:\/\/other\.com\/page">b<\/a>/,
  );
});

Deno.test("applyExternalLinkClass: leaves an anchor with no href untouched", () => {
  const html = applyExternalLinkClass('<a name="top">anchor</a>', "external");
  assertEquals(html, '<a name="top">anchor</a>');
});

Deno.test("plugin-markdown-extensions: externalLinkClass: false disables the pass", async () => {
  const plugin = createPlugin({ externalLinkClass: false });
  const html = await plugin.transformHtml?.(
    '<a href="https://other.com">x</a>',
  );
  assertEquals(html, '<a href="https://other.com">x</a>');
});

Deno.test("plugin-markdown-extensions: transformHtml uses a custom class name", async () => {
  const plugin = createPlugin({ externalLinkClass: "outbound" });
  const html = await plugin.transformHtml?.(
    '<a href="https://other.com">x</a>',
  );
  assertStringIncludes(html as string, 'class="outbound"');
});
