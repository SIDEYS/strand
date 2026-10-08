import { forwardRef, useDeferredValue, useMemo } from 'react';
import { renderMarkdown } from './markdown.js';

interface PreviewProps {
  markdown: string;
  onScroll: () => void;
}

/** The rendered pane. `useDeferredValue` lets typing stay responsive while a
 * large document re-renders behind it. */
export const Preview = forwardRef<HTMLDivElement, PreviewProps>(function Preview({ markdown, onScroll }, ref) {
  const deferred = useDeferredValue(markdown);
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  return (
    <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto bg-white px-8 py-6 dark:bg-slate-900" data-testid="preview">
      {/* Safe only because renderMarkdown sanitises; see the note there. */}
      <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});
