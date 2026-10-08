import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Links in a collaborator's document must not be able to take over this tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/**
 * Markdown to HTML for the preview pane.
 *
 * This is an XSS sink, not a formality. The text being rendered was written by
 * other people, live, in a shared room: anyone who can join can put arbitrary
 * HTML in front of every other collaborator's browser, in the same origin as
 * the app. `marked` passes raw HTML straight through by design, so the output
 * must never reach the DOM unsanitised. DOMPurify strips scripts, event
 * handler attributes, and javascript: URLs; <style> and style attributes are
 * also removed because CSS can be used to overlay or restyle the UI to
 * mislead, and to leak data through attribute selectors and URLs.
 */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}
