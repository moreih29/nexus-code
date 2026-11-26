import i18next from "i18next";
import { memo, useCallback, useMemo } from "react";
import { type Components, defaultUrlTransform } from "react-markdown";
import { isNetworkLink } from "../../../shared/fs/outside-url";
import {
  type FileLinkSource,
  type LinkedFile,
  useChatFiles,
  useFileLinkSource,
} from "../../services/chat/chat-files";
import { isUnknownFile, useFoundFiles } from "../../services/chat/file-presence";
import {
  grantsOf,
  type LinkState,
  linkKey,
  pathInRoot,
  useLinksFound,
} from "../../services/chat/linked-files";
import { fileKind, resolveFilePath } from "../../services/chat/links";
import { openOrRevealEditor } from "../../services/editor";
import { classifyLinkHref } from "../../services/editor/preview/link-router";
import { ImageName, MarkdownBody } from "../ui/markdown-body";
import { showToast } from "../ui/toast";
import { LinkMenu, useChatLinks, useLinkPlaces } from "./chat-links";
import { FileImage, ImageChip } from "./file-image";
import { FileKindIcon } from "./file-kind-icon";

interface ChatMarkdownProps {
  text: string;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  shownEarlier?: ReadonlySet<string>;
}

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  workspaceId,
  cwd,
  rootPath,
  shownEarlier,
}: ChatMarkdownProps) {
  const links = useChatLinks();
  const placesOf = useLinkPlaces();
  const files = useChatFiles();
  const linkSource = useFileLinkSource();
  const hostSource = grantsOf(files) ? linkSource : null;
  const viaHost = useCallback(
    (href: string) => hostSource !== null && pathInRoot(href, cwd, rootPath) === null,
    [hostSource, cwd, rootPath],
  );
  const onLink = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (links && hostSource && viaHost(href) && fileLike(href, cwd)) {
        links.openFile(href, { link: { href, source: hostSource } });
        return;
      }
      if (isNetworkLink(href)) {
        showToast({ kind: "error", message: i18next.t("chat.links.network_path") });
        return;
      }
      const classified = classifyLinkHref(href, {
        currentFileAbsPath: `${cwd.replace(/\/$/, "")}/.chat`,
        workspaceRootAbsPath: rootPath,
        kind: "link",
      });
      if (links) {
        if (classified.kind === "external") links.openUrl(classified.href);
        else if (resolveFilePath(href, cwd)) links.openFile(href);
        else if (classified.kind === "internal-file") links.openFile(classified.absPath);
        return;
      }
      if (classified.kind === "external") {
        window.open(classified.href, "_blank", "noopener,noreferrer");
      } else if (classified.kind === "internal-file") {
        openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
      }
    },
    [cwd, rootPath, workspaceId, links, hostSource, viaHost],
  );

  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...rest }) {
        const safe = typeof href === "string" ? href : "";
        const link = (icon?: React.ReactNode) => (
          <a {...rest} href={safe} title={safe} onClick={(e) => onLink(safe, e)}>
            {icon}
            {children}
          </a>
        );
        if (hostSource && viaHost(safe) && fileLike(safe, cwd)) {
          const path = placesOf(safe, cwd)[0]?.path ?? safe;
          return (
            <HostFileLink
              href={safe}
              source={hostSource}
              path={path}
              link={link(
                <FileKindIcon path={path} className="mr-0.5 inline size-3.5 align-[-0.15em]" />,
              )}
            >
              {children}
            </HostFileLink>
          );
        }
        if (isNetworkLink(safe)) return link();
        const kind = linkKind(safe, cwd);
        if (kind === "file") {
          const places = placesOf(safe, cwd).map((place) => place.path);
          const path = places[0] ?? safe;
          return (
            <FileLink
              places={places}
              href={safe}
              workspaceId={workspaceId}
              rootPath={rootPath}
              link={link(
                <FileKindIcon path={path} className="mr-0.5 inline size-3.5 align-[-0.15em]" />,
              )}
            >
              {children}
            </FileLink>
          );
        }
        return kind ? (
          <LinkMenu target={safe} href={safe} kind={kind}>
            {link()}
          </LinkMenu>
        ) : (
          link()
        );
      },
      img({ src, alt }) {
        const label = <ImageName alt={alt} />;
        if (typeof src === "string" && hostSource && viaHost(src) && fileLike(src, cwd)) {
          const path = placesOf(src, cwd)[0]?.path ?? src;
          if (fileKind(path) !== "image") return label;
          return (
            <HostImage
              href={src}
              source={hostSource}
              path={path}
              workspaceId={workspaceId}
              alt={alt ?? ""}
              shownEarlier={shownEarlier}
              fallback={label}
            />
          );
        }
        if (typeof src === "string" && isNetworkLink(src)) return label;
        const places =
          typeof src === "string" && linkKind(src, cwd) === "file"
            ? placesOf(src, cwd).map((place) => place.path)
            : [];
        const [path] = places;
        if (!path || fileKind(path) !== "image") return label;
        if (shownEarlier?.has(path)) return <ImageChip path={path} />;
        if (places.length === 1) {
          return (
            <FileImage path={path} workspaceId={workspaceId} alt={alt ?? ""} fallback={label} />
          );
        }
        return (
          <PlacedImage
            places={places}
            workspaceId={workspaceId}
            rootPath={rootPath}
            alt={alt ?? ""}
            shownEarlier={shownEarlier}
            fallback={label}
          />
        );
      },
    }),
    [onLink, placesOf, cwd, workspaceId, rootPath, shownEarlier, hostSource, viaHost],
  );

  return (
    <div className="md-preview chat-md">
      <MarkdownBody source={text} components={components} urlTransform={keepFileUrls} />
    </div>
  );
});

function keepFileUrls(url: string): string {
  return isNetworkLink(url) ||
    /^[A-Za-z]:([\\/]|%5C)/i.test(url) ||
    /^file:\/\//i.test(url) ||
    /^[\w.-]+\.\w+:\d+(:\d+)?$/.test(url)
    ? url
    : defaultUrlTransform(url);
}

function FileLink({
  places,
  href,
  workspaceId,
  rootPath,
  link,
  children,
}: {
  places: readonly string[];
  href: string;
  workspaceId: string;
  rootPath: string;
  link: React.ReactElement;
  children: React.ReactNode;
}) {
  const found = useFoundFiles(workspaceId, rootPath, places);
  const path =
    places.find((place) => found.has(place)) ??
    places.find((place) => isUnknownFile(place, rootPath));
  if (!path) return <span title={href}>{children}</span>;
  return (
    <LinkMenu target={path} href={href} kind="file">
      {link}
    </LinkMenu>
  );
}

function PlacedImage({
  places,
  workspaceId,
  rootPath,
  alt,
  shownEarlier,
  fallback,
}: {
  places: readonly string[];
  workspaceId: string;
  rootPath: string;
  alt: string;
  shownEarlier: ReadonlySet<string> | undefined;
  fallback: React.ReactNode;
}) {
  const found = useFoundFiles(workspaceId, rootPath, places);
  const path = places.find((place) => found.has(place)) ?? places[0];
  if (shownEarlier?.has(path)) return <ImageChip path={path} />;
  return <FileImage path={path} workspaceId={workspaceId} alt={alt} fallback={fallback} />;
}

function fileLike(href: string, cwd: string): boolean {
  return isNetworkLink(href) || linkKind(href, cwd) === "file";
}

function useHostLink(href: string, source: FileLinkSource): [LinkedFile, LinkState | undefined] {
  const linked = useMemo(() => ({ href, source }), [href, source]);
  const asked = useMemo(() => [linked], [linked]);
  return [linked, useLinksFound(asked)?.get(linkKey(linked))];
}

function HostFileLink({
  href,
  source,
  path,
  link,
  children,
}: {
  href: string;
  source: FileLinkSource;
  path: string;
  link: React.ReactElement;
  children: React.ReactNode;
}) {
  const [linked, found] = useHostLink(href, source);
  if (found === undefined || found === null) return <span title={href}>{children}</span>;
  const target = found !== "failed" && "path" in found ? found.path : path;
  return (
    <LinkMenu target={target} href={href} kind="file" link={linked}>
      {link}
    </LinkMenu>
  );
}

function HostImage({
  href,
  source,
  path,
  workspaceId,
  alt,
  shownEarlier,
  fallback,
}: {
  href: string;
  source: FileLinkSource;
  path: string;
  workspaceId: string;
  alt: string;
  shownEarlier: ReadonlySet<string> | undefined;
  fallback: React.ReactNode;
}) {
  const [linked, found] = useHostLink(href, source);
  if (found === undefined || found === null) return <>{fallback}</>;
  if (found === "failed" || !("path" in found) || !found.readable) {
    return (
      <ImageChip path={found !== "failed" && "path" in found ? found.path : path} link={linked} />
    );
  }
  if (shownEarlier?.has(found.path)) return <ImageChip path={found.path} link={linked} />;
  return (
    <FileImage
      path={found.path}
      workspaceId={workspaceId}
      alt={alt}
      fallback={fallback}
      link={linked}
    />
  );
}

function linkKind(href: string, cwd: string): "file" | "url" | null {
  if (/^https?:\/\//i.test(href)) return "url";
  if (href.startsWith("#")) return null;
  return resolveFilePath(href, cwd) ? "file" : null;
}
