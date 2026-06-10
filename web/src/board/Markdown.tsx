// Rendered-markdown view for a Task body (#22). GFM is enabled (remark-gfm) so
// task lists `- [ ]` / `- [x]` render as real checkboxes; we force every such
// checkbox DISABLED so the acceptance-criteria checklist is a read-only view
// (editing happens through the raw-markdown textarea in edit mode, not here).
//
// Styling stays light: a handful of Tailwind utility classes give the prose a
// readable rhythm on the board's warm-paper aesthetic, without pulling in a
// typography plugin.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // GFM task-list checkboxes: always disabled (read-only checklist view).
          input(props) {
            if (props.type === "checkbox") {
              return (
                <input
                  type="checkbox"
                  checked={props.checked ?? false}
                  disabled
                  readOnly
                  className="mr-1.5 align-middle accent-slate-600"
                />
              );
            }
            return <input {...props} />;
          },
          h1: (p) => <h1 className="mt-3 mb-1.5 text-lg font-semibold text-slate-800" {...p} />,
          h2: (p) => <h2 className="mt-3 mb-1.5 text-base font-semibold text-slate-800" {...p} />,
          h3: (p) => <h3 className="mt-2.5 mb-1 text-sm font-semibold text-slate-800" {...p} />,
          p: (p) => <p className="my-1.5" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal pl-5" {...p} />,
          li: (p) => <li className="my-0.5" {...p} />,
          a: ({ href, ...p }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline underline-offset-2"
              {...p}
            />
          ),
          code: (p) => (
            <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[12.5px]" {...p} />
          ),
          pre: (p) => (
            <pre className="my-2 overflow-x-auto rounded bg-black/5 p-2.5 font-mono text-[12.5px]" {...p} />
          ),
          blockquote: (p) => (
            <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600" {...p} />
          ),
          table: (p) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" {...p} />
            </div>
          ),
          th: (p) => <th className="border border-slate-300 px-2 py-1 text-left font-semibold" {...p} />,
          td: (p) => <td className="border border-slate-200 px-2 py-1" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
