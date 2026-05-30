/**
 * Markdown rendering for chat messages.
 *
 * marked → DOMPurify pipeline. We render synchronously (sync mode is the
 * default in marked v18) so the UI can write the result straight into
 * dangerouslySetInnerHTML without waiting on a Promise.
 *
 * Sanitization is mandatory: assistant output is untrusted by default
 * (the agent can be manipulated by tool output, hostile context, etc.),
 * so we strip every event handler and unsafe protocol before rendering.
 *
 * Code blocks get a `mono` class so the existing CSS picks up the
 * monospace font; inline code already has a default style in index.css.
 */
import DOMPurify from "dompurify";
import type { Config as DOMPurifyConfig } from "dompurify";
import { Marked } from "marked";
import { isDiffLang, renderDiff } from "./diff";

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
});

// Phase 6.E — intercept fenced code blocks tagged `diff` / `patch` /
// `udiff` and replace marked's default <pre><code class="language-diff">
// output with our line-classified diff renderer. Falls back to the
// default behaviour for every other language.
marked.use({
  renderer: {
    code(token) {
      const text = token.text ?? "";
      const lang = token.lang ?? "";
      if (isDiffLang(lang)) {
        return renderDiff(text);
      }
      // Defer to the default renderer by returning false (marked's
      // contract: a falsy return from a custom renderer makes it fall
      // back to the built-in implementation).
      return false as unknown as string;
    },
  },
});

const SAFE_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "del",
    "ins",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
    "div",
  ],
  ALLOWED_ATTR: ["href", "title", "alt", "src", "class", "target", "rel"],
  // Disallow data: / javascript: / vbscript: URLs.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  RETURN_TRUSTED_TYPE: false,
};

export function renderMarkdown(input: string): string {
  if (!input) return "";
  const raw = marked.parse(input) as string;
  return DOMPurify.sanitize(raw, SAFE_CONFIG) as unknown as string;
}

/**
 * Force every <a> in rendered markdown to open in a new tab and disable
 * referrer leakage. Used as a small post-processing step in the React
 * component. Pure DOM mutation — call after the HTML is mounted.
 */
export function hardenLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll("a")) {
    if (!a.getAttribute("rel")) a.setAttribute("rel", "noopener noreferrer");
    if (!a.getAttribute("target")) a.setAttribute("target", "_blank");
  }
}
