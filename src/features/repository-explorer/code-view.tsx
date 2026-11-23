import { Highlight, themes, type Language } from "prism-react-renderer";
import type { SourceFile } from "@/features/repository-import/repository-session";

function language(path: string): Language {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.[cm]?ts$/i.test(path)) return "typescript";
  if (/\.jsx$/i.test(path)) return "jsx";
  if (/\.[cm]?js$/i.test(path)) return "javascript";
  if (/\.json$/i.test(path)) return "json";
  if (/\.css$/i.test(path)) return "css";
  if (/\.html$/i.test(path)) return "markup";
  if (/\.md$/i.test(path)) return "markdown";
  return "plain";
}
export function CodeView({ file }: { file: SourceFile }) {
  return (
    <Highlight
      theme={themes.github}
      code={file.content}
      language={language(file.path)}
    >
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="code-view" aria-label={`Source code: ${file.path}`}>
          <code>
            {tokens.map((line, index) => (
              <span className="code-line" key={index}>
                <span className="line-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span {...getLineProps({ line })}>
                  {line.map((token, i) => (
                    <span key={i} {...getTokenProps({ token })} />
                  ))}
                </span>
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
