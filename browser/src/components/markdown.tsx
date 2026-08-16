import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ExternalLink } from "lucide-react";

function Bookmark({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="not-prose flex items-stretch border border-rule hover:bg-paper-warm/50 transition-colors no-underline my-2 overflow-hidden"
    >
      <div className="flex-1 px-3 py-2 min-w-0">
        <div className="text-ink text-sm truncate">{children}</div>
        <div className="mono text-[10px] text-ink-4 truncate mt-0.5">{href}</div>
      </div>
      <div className="w-9 shrink-0 bg-paper-warm/50 border-l border-rule-light flex items-center justify-center">
        <ExternalLink size={12} className="text-ink-4" />
      </div>
    </a>
  );
}

export const notionMarkdownComponents = {
  a: ({ href, children }: any) => {
    if (!href) return <span>{children}</span>;
    return <Bookmark href={href}>{children}</Bookmark>;
  },
};

export const mdPlugins = {
  remarkPlugins: [remarkMath] as any[],
  rehypePlugins: [rehypeKatex] as any[],
};

// Agents are instructed to use `\(...\)` for inline math and `\[...\]` for
// display math (these survive shell evaluation, unlike `$...$` / `$$...$$`
// which expand `$$` to the bash PID — see commit history). remark-math only
// recognizes dollar delimiters, so rewrite the LaTeX-style delimiters to
// dollars before parsing. Also repair legacy summaries where `$$` was
// already corrupted to a `<pid>...<pid>` pair around math markers.
function preprocessMath(src: string): string {
  let s = src;
  // \[ ... \] → $$ ... $$ (display math). Non-greedy, multiline.
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`);
  // \( ... \) → $ ... $ (inline math). Single-line to avoid swallowing prose.
  s = s.replace(/\\\(([^\n]+?)\\\)/g, (_m, body) => `$${body}$`);
  // Repair: <digits><math><same digits> with NO whitespace between the
  // digits and the math body means `$$` got expanded to the worker's bash
  // PID twice (PID adjacent to math content, since `$$` had no space).
  // Lookahead/lookbehind on \S avoids matching year repetitions like
  // "2024 ... 2024" where digits sit at word boundaries.
  s = s.replace(/(\d{4,7})(?=\S)([\s\S]+?)(?<=\S)\1/g, (m, _pid, body) => {
    if (
      /\\(?:frac|sum|prod|int|hat|tilde|bar|text|mathbb|mathcal|mathrm|alpha|beta|lambda|sigma|theta|cdot|leq|geq|neq|approx|partial|nabla|infty)\b/.test(
        body,
      )
    ) {
      return `$$${body}$$`;
    }
    return m;
  });
  return s;
}

export function Md({ children, components }: { children: string; components?: any }) {
  return (
    <Markdown remarkPlugins={mdPlugins.remarkPlugins} rehypePlugins={mdPlugins.rehypePlugins} components={components}>
      {preprocessMath(children)}
    </Markdown>
  );
}

export function MdNotion({ children }: { children: string }) {
  return <Md components={notionMarkdownComponents}>{children}</Md>;
}
