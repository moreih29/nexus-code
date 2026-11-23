import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { openReleasePage } from "../../state/operations/release-notes";

function remarkWholeHtml() {
  return (tree: unknown, file: { value: unknown }) => {
    (tree as { children: unknown[] }).children = [{ type: "html", value: String(file.value) }];
  };
}

const MARKDOWN_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  a({ href, children, node: _node, ...rest }) {
    const target = typeof href === "string" ? href : "";
    return (
      <a
        {...rest}
        href={target}
        onClick={(event) => {
          event.preventDefault();
          openReleasePage(target);
        }}
      >
        {children}
      </a>
    );
  },
};

export function ReleaseNotesHtml({ html }: { html: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkWholeHtml]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={MARKDOWN_COMPONENTS}
    >
      {html}
    </ReactMarkdown>
  );
}
