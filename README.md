# @steno/plugin-markdown-extensions

Markdown-extensions plugin for [Steno](https://github.com/steno/steno) that restores the
Markdown-level conveniences [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark)
(Zola's Markdown engine) gives for free, on top of Steno's `marked`-based pipeline: smart
punctuation, bottom-of-page footnotes, GitHub-style alert callouts, and an automatic class on
external links.

This is for a site migrating from Zola, or any theme wanting these four common Markdown behaviors
without hand-writing its own token transforms.

## Installation

```yaml
# content/.steno/config.yml
plugins:
  - jsr:@steno/plugin-markdown-extensions
```

## Options

```yaml
plugins:
  - package: jsr:@steno/plugin-markdown-extensions
    options:
      smartPunctuation: true
      footnotes: bottom
      githubAlerts: true
      externalLinkClass: external
```

| Option              | Type                   | Default      | Description                                                                                                                                                                                             |
| ------------------- | ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smartPunctuation`  | `boolean`              | `true`       | Converts straight quotes/dashes/ellipses to their typographic equivalents. Never touches `code`/`codespan` tokens.                                                                                        |
| `footnotes`         | `"bottom" \| "inline"` | `"bottom"`   | See "Footnotes" below for exactly what `"bottom"` covers. `"inline"` is an explicit no-op passthrough, kept so a site can opt back out without removing the plugin.                                       |
| `githubAlerts`      | `boolean`              | `true`       | Recognizes `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` blockquote prefixes and renders them as styled callouts using `markdown-alert markdown-alert-<type>` classes.        |
| `externalLinkClass` | `string \| false`      | `"external"` | Class appended to any `<a href>` whose host differs from `baseUrl`. `false` disables the pass entirely. An empty string is rejected — use `false` instead.                                                |
| `baseUrl`           | `string`               | unset        | The site's own base URL, used to tell "external" from "internal" for `externalLinkClass`. Unset means: any absolute `http://`/`https://` URL is external, anything else is internal.                     |

`mailto:`, `tel:`, and fragment-only (`#...`) links are always treated as internal, regardless of
`baseUrl`.

## How it works

`transformAst` runs on `marked`'s real token list (from `marked.lexer()`) before rendering, so
alert-block detection and footnote reordering happen at the AST level, not via regex over the final
HTML. External-link classing runs as a `transformHtml` pass instead, since it needs the resolved
`<a href>` output and the site's own base URL to tell "external" from "internal."

Inside `transformAst`, the three passes run in this order: GitHub alerts first, then footnotes, then
smart punctuation — each only touching the parts of the tree the earlier passes didn't already turn
into raw HTML. Smart punctuation is also applied to alert bodies and footnote definitions themselves
(as plain text, before they're re-rendered to HTML), so typography stays consistent even inside those.

### Footnotes: what `"bottom"` actually does

`marked` (the engine this plugin runs on) has no footnote syntax of its own — `[^1]` and `[^1]: ...`
lex as ordinary literal text and a plain paragraph, respectively, with nothing rendered. So `"bottom"`
isn't a passthrough to an existing `marked` feature; this plugin implements footnote parsing itself,
deliberately kept conservative given there's no upstream behavior to lean on:

- Only top-level `[^id]: body` paragraphs are recognized as definitions — not ones inside a list,
  blockquote, or table.
- A definition is only extracted and rendered when at least one matching `[^id]` reference exists
  elsewhere in the document. An orphaned definition with no reference is left as ordinary text.
- A reference is only replaced when a matching definition exists; an unmatched `[^id]` is left
  exactly as `marked` would already render it.
- References are renumbered sequentially by first appearance and rendered as
  `<sup id="fnref-<slug>"><a href="#fn-<slug>" class="footnote-ref">[n]</a></sup>`; the collected
  definitions are appended as `<section class="footnotes"><ol>...</ol></section>`, each entry linking
  back to its first reference with a `class="footnote-backref"` anchor.

`"inline"` skips this pass entirely, leaving `[^id]` syntax exactly as `marked` would already leave
it unmodified.

### GitHub alerts

The emitted markup is:

```html
<div class="markdown-alert markdown-alert-note">
  <p class="markdown-alert-title">Note</p>
  <p>Body content, rendered from Markdown.</p>
</div>
```

`markdown-alert` / `markdown-alert-<type>` match GitHub's own alert class convention, so most themes'
existing alert-callout CSS applies unchanged. The title itself renders as a plain
`<p class="markdown-alert-title">`, English-only — a theme wanting a localized or icon-bearing title
should style/override `markdown-alert-title` itself, or post-process this plugin's output with its
own `transformHtml` pass.

## Test

```sh
deno task test
```

57 tests cover each feature independently: defaults, disabling each option, nested markup (emphasis,
list items, table cells), already-curly text staying untouched, malformed alert/footnote syntax being
left alone, external-link detection with and without `baseUrl`, and the `transformAst`/`transformHtml`
return shapes the build pipeline requires.

## Learn more

- [Steno plugin development guide](https://github.com/stenopress/steno/blob/main/docs/plugins.md)
- [Steno plugin sandbox and threat model](https://github.com/stenopress/steno/blob/main/docs/plugin_sandbox.md)
- [Zola Markdown config reference](https://www.getzola.org/documentation/getting-started/configuration/#markdown) — the feature set this plugin ports

## License

MIT
