#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../src/shared/agent/envelope";
import {
  type AgentArtifactPlatform,
  type AgentBinaryManifestEntry,
  AgentManifestSchema,
  type LspBinaryManifestEntry,
  type NodeRuntimeManifestEntry,
} from "../src/shared/agent/manifest";

const DEFAULT_VERSION = "0.1.0";
// Manifest metadata follows the single source of truth in envelope.ts —
// an independent literal here drifted to "1" while the wire went to "2".
const DEFAULT_PROTOCOL_VERSION = AGENT_PROTOCOL_VERSION;
// The LTS line the SSH hosts' Node runtime comes from. Node 20 reached end of
// life in April 2026 and got no fix in the October 2026 security release.
// Node 24 needs glibc 2.28 on Linux, as 20 did, and macOS 13.5.
const NODE_MAJOR = 24;
// nodejs.org serves its releases under two paths, which its CDN caches apart.
const NODE_DIST_BASE_URLS = ["https://nodejs.org/dist", "https://nodejs.org/download/release"];

/** The hosts an SSH workspace runs on; each also gets a Node runtime. */
const SSH_HOST_TARGETS = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
] as const satisfies readonly AgentArtifactPlatform[];

/** The SSH hosts, plus Windows, where the agent serves only the local app. */
export const AGENT_BUILD_TARGETS = [
  ...SSH_HOST_TARGETS,
  { os: "windows", arch: "amd64" },
  { os: "windows", arch: "arm64" },
] as const satisfies readonly AgentArtifactPlatform[];

const LSP_BUNDLES = [
  {
    name: "typescript-language-server",
    packageName: "typescript-language-server",
    languages: ["typescript", "javascript"],
    entry: "node_modules/typescript-language-server/lib/cli.mjs",
    launcher: "bin/typescript-language-server",
    argsTemplate: ["--stdio"],
    extraDependencies: ["typescript"],
  },
  {
    // basedpyright is a community fork of microsoft/pyright that adds the
    // language-server features Microsoft keeps behind closed-source Pylance —
    // most importantly the semanticTokensProvider that the renderer relies
    // on for syntax-aware colouring. The fork preserves pyright's bin names
    // (`pyright-langserver`) and `langserver.index.js` entry path, so the
    // launcher and manifest lookup keys stay byte-identical.
    name: "pyright-langserver",
    packageName: "basedpyright",
    languages: ["python"],
    entry: "node_modules/basedpyright/langserver.index.js",
    launcher: "bin/pyright-langserver",
    argsTemplate: ["--stdio"],
    extraDependencies: [],
  },
  {
    name: "yaml-language-server",
    packageName: "yaml-language-server",
    languages: ["yaml"],
    entry: "node_modules/yaml-language-server/bin/yaml-language-server",
    launcher: "bin/yaml-language-server",
    argsTemplate: ["--stdio"],
    extraDependencies: [],
  },
] as const;

interface BuildAgentDistributionOptions {
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly version?: string;
  readonly protocolVersion?: string;
  readonly nodeVersion?: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<void>;

interface BuildDependencies {
  readonly run?: Runner;
  readonly fetch?: typeof fetch;
}

interface ManifestArtifactInput extends AgentArtifactPlatform {
  readonly path: string;
}

interface RuntimeArtifactInput extends ManifestArtifactInput {
  readonly version: string;
  readonly entry: string;
}

interface LspArtifactInput {
  readonly name: string;
  readonly packageName: string;
  readonly version: string;
  readonly languages: readonly string[];
  readonly path: string;
  readonly entry: string;
  readonly launcher: string;
  readonly argsTemplate: readonly string[];
}

export async function buildAgentDistribution(
  options: BuildAgentDistributionOptions = {},
  dependencies: BuildDependencies = {},
): Promise<void> {
  const rootDir = options.rootDir ?? path.resolve(import.meta.dir, "..");
  const outDir = options.outDir ?? path.join(rootDir, "dist", "agent");
  // 에이전트 바이너리 버전은 앱 버전(package.json)에서 파생한다. 이 값이
  // manifest.version → 원격 설치 경로(agent-<version>-os-arch)와 Ready 핸드셰이크의
  // serverVersion을 결정한다. 고정값(DEFAULT_VERSION)으로 두면 릴리스마다 동일한
  // 원격 경로를 in-place 덮어쓰게 되고 KEEP_REMOTE_VERSIONS 프루닝이 무의미해진다.
  // 호환성 계약 자체는 별개의 protocolVersion이 담당한다.
  const version = options.version ?? (await readAppVersion(rootDir)) ?? DEFAULT_VERSION;
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const run = dependencies.run ?? runCommand;

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const agentArtifacts = await buildAgentBinaries({ rootDir, outDir, version, run });
  const nodeVersion =
    options.nodeVersion ?? (await nodeRuntimeVersion(dependencies.fetch ?? fetch));
  const nodeArtifacts = await downloadNodeRuntimes({ outDir, nodeVersion }, dependencies.fetch);
  const lspArtifacts = await buildLspBundles({ rootDir, outDir, run });

  // claude 래퍼 스크립트를 bin/claude로 배치.
  const wrapperArtifact = await copyClaudeWrapper({ rootDir, outDir });

  await writeAgentManifest({
    outDir,
    version,
    protocolVersion,
    agentArtifacts,
    nodeArtifacts,
    lspArtifacts,
    wrapperArtifact,
  });
  console.log(`Built agent distribution in ${outDir}`);
}

/**
 * scripts/assets/claude-wrapper.sh 를 <outDir>/bin/claude 로 복사하고
 * 실행 권한(0o755)을 설정한다. 파일이 없으면 에러를 던진다.
 */
export async function copyClaudeWrapper(args: {
  readonly rootDir: string;
  readonly outDir: string;
}): Promise<{ readonly path: string; readonly sha256: string; readonly size: number }> {
  const src = path.join(args.rootDir, "scripts", "assets", "claude-wrapper.sh");
  const binDir = path.join(args.outDir, "bin");
  const dest = path.join(binDir, "claude");

  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(src, dest);
  await fs.chmod(dest, 0o755);

  const metadata = await fileMetadata(dest);
  console.log(`Copied claude wrapper to ${dest} (sha256=${metadata.sha256})`);
  return { path: path.join("bin", "claude"), ...metadata };
}

export async function writeAgentManifest(args: {
  readonly outDir: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly agentArtifacts: readonly ManifestArtifactInput[];
  readonly nodeArtifacts: readonly RuntimeArtifactInput[];
  readonly lspArtifacts: readonly LspArtifactInput[];
  readonly wrapperArtifact?: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  };
}): Promise<void> {
  const binaries: AgentBinaryManifestEntry[] = [];
  for (const artifact of args.agentArtifacts) {
    const metadata = await fileMetadata(path.join(args.outDir, artifact.path));
    binaries.push({ ...artifact, ...metadata });
  }

  const node: NodeRuntimeManifestEntry[] = [];
  for (const artifact of args.nodeArtifacts) {
    const metadata = await fileMetadata(path.join(args.outDir, artifact.path));
    node.push({ ...artifact, ...metadata });
  }

  const lspBinaries: LspBinaryManifestEntry[] = [];
  for (const artifact of args.lspArtifacts) {
    const metadata = await fileMetadata(path.join(args.outDir, artifact.path));
    lspBinaries.push({
      ...artifact,
      languages: [...artifact.languages],
      argsTemplate: [...artifact.argsTemplate],
      ...metadata,
    });
  }

  const manifest = AgentManifestSchema.parse({
    version: args.version,
    protocolVersion: args.protocolVersion,
    binaries,
    runtime: { node },
    lspBinaries,
    wrapper: args.wrapperArtifact,
  });
  await fs.writeFile(
    path.join(args.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function buildAgentBinaries(args: {
  readonly rootDir: string;
  readonly outDir: string;
  readonly version: string;
  readonly run: Runner;
}): Promise<ManifestArtifactInput[]> {
  const artifacts: ManifestArtifactInput[] = [];
  for (const target of AGENT_BUILD_TARGETS) {
    const extension = target.os === "windows" ? ".exe" : "";
    const name = `agent-${args.version}-${target.os}-${target.arch}${extension}`;
    await args.run(
      "go",
      [
        "build",
        "-tags=netgo,osusergo",
        // The agent reports this version on its Ready frame and keys its SSH
        // daemon's run files by it, as computeWsId does on this side.
        `-ldflags=-s -w -X github.com/nexus-code/nexus-code/internal/proto.ServerVersion=${args.version}`,
        "-o",
        path.join(args.outDir, name),
        "./cmd/agent",
      ],
      {
        cwd: args.rootDir,
        // CGO_ENABLED=0 forces a fully static binary. Without it the linux/amd64
        // target is a *native* build on the CI runner, where Go defaults
        // CGO_ENABLED to 1; because the agent imports "net" (and os/user), the
        // binary then dynamically links the runner's glibc and requires that
        // exact version at runtime — failing on older distros such as Ubuntu
        // 20.04 (glibc 2.31) with "version `GLIBC_x.xx' not found". The
        // netgo/osusergo tags keep the net and os/user resolvers in pure Go so
        // disabling cgo does not silently change name resolution behavior.
        env: { ...process.env, GOOS: target.os, GOARCH: target.arch, CGO_ENABLED: "0" },
      },
    );
    artifacts.push({ ...target, path: name });
  }
  return artifacts;
}

async function downloadNodeRuntimes(
  args: {
    readonly outDir: string;
    readonly nodeVersion: string;
  },
  fetchFn = fetch,
): Promise<RuntimeArtifactInput[]> {
  const runtimeDir = path.join(args.outDir, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const artifacts: RuntimeArtifactInput[] = [];
  // A tarball can be pieced together from several attempts over two paths,
  // so it must match the SHA-256 nodejs.org lists for it.
  const checksums = await nodeChecksums(args.nodeVersion, fetchFn);
  // CI keeps the tarballs here between runs, so most runs fetch none of them.
  const cacheDir = process.env.NODE_RUNTIME_CACHE_DIR;

  for (const target of SSH_HOST_TARGETS) {
    const platform = nodeDistPlatform(target);
    const archive = `node-${args.nodeVersion}-${platform}.tar.gz`;
    const relativePath = path.join("runtime", archive);
    const destination = path.join(args.outDir, relativePath);
    const expected = checksums.get(archive);
    const cached = cacheDir ? path.join(cacheDir, archive) : undefined;
    const cachedSha256 = cached && (await fileMetadata(cached).catch(() => undefined))?.sha256;
    if (cached && expected && cachedSha256 === expected) {
      await fs.copyFile(cached, destination);
      console.log(`Took ${archive} from ${cacheDir}`);
    } else {
      await downloadFile(`${args.nodeVersion}/${archive}`, destination, fetchFn);
      const { sha256 } = await fileMetadata(destination);
      if (sha256 !== expected) {
        throw new Error(`${archive} does not match the SHA-256 nodejs.org lists (got ${sha256})`);
      }
      if (cached) {
        await fs.mkdir(path.dirname(cached), { recursive: true });
        await fs.copyFile(destination, cached);
      }
    }
    artifacts.push({
      ...target,
      version: args.nodeVersion,
      path: relativePath,
      entry: "bin/node",
    });
  }

  return artifacts;
}

/** The SHA-256 of each file in a Node release, by file name, from its SHASUMS256.txt. */
async function nodeChecksums(
  nodeVersion: string,
  fetchFn: typeof fetch,
): Promise<Map<string, string>> {
  const text = await fetchWithRetry(`${nodeVersion}/SHASUMS256.txt`, fetchFn, async (response) => {
    if (!response.ok) {
      throw new Error(`failed to fetch Node ${nodeVersion} checksums: HTTP ${response.status}`);
    }
    return response.text();
  });
  const checksums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match) checksums.set(match[2], match[1]);
  }
  return checksums;
}

// On Windows, use the bsdtar that ships as System32\tar.exe. Git Bash puts
// GNU tar first on PATH, and GNU tar reads "C:\..." as host "C" and fails.
function tarCommand(): string {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

async function buildLspBundles(args: {
  readonly rootDir: string;
  readonly outDir: string;
  readonly run: Runner;
}): Promise<LspArtifactInput[]> {
  const lspOutDir = path.join(args.outDir, "lsp");
  await fs.mkdir(lspOutDir, { recursive: true });

  const artifacts: LspArtifactInput[] = [];
  for (const bundle of LSP_BUNDLES) {
    const version = await installedPackageVersion(args.rootDir, bundle.packageName);
    // Install once into the published extracted directory so local agent
    // launches reuse it as a node module tree, then tar from that same
    // tree for SSH uploads. Avoids the previous pattern of installing
    // into a throwaway staging dir and only shipping the archive — local
    // mode could not consume the archive directly.
    const extractedDir = path.join(lspOutDir, `${bundle.name}-${version}`);
    await fs.rm(extractedDir, { recursive: true, force: true });
    await fs.mkdir(extractedDir, { recursive: true });
    const dependencies: Record<string, string> = {
      [bundle.packageName]: version,
    };
    for (const dependency of bundle.extraDependencies) {
      dependencies[dependency] = await installedPackageVersion(args.rootDir, dependency);
    }
    await fs.writeFile(
      path.join(extractedDir, "package.json"),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    );
    await args.run(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: extractedDir },
    );

    const archiveName = `${bundle.name}-${version}.tar.gz`;
    await args.run(
      tarCommand(),
      ["-czf", path.join(lspOutDir, archiveName), "-C", extractedDir, "."],
      {
        cwd: args.rootDir,
      },
    );
    artifacts.push({
      name: bundle.name,
      packageName: bundle.packageName,
      version,
      languages: [...bundle.languages],
      path: path.join("lsp", archiveName),
      entry: bundle.entry,
      launcher: bundle.launcher,
      argsTemplate: [...bundle.argsTemplate],
    });
  }

  return artifacts;
}

async function installedPackageVersion(rootDir: string, packageName: string): Promise<string> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(rootDir, "node_modules", packageName, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`missing installed package version for ${packageName}`);
  }
  return packageJson.version;
}

/** NODE_RUNTIME_VERSION when set, else the latest LTS release of NODE_MAJOR. */
async function nodeRuntimeVersion(fetchFn: typeof fetch): Promise<string> {
  return (
    normalizeNodeVersion(process.env.NODE_RUNTIME_VERSION ?? "") ??
    (await resolveLatestNodeLtsVersion(fetchFn))
  );
}

async function resolveLatestNodeLtsVersion(fetchFn: typeof fetch): Promise<string> {
  const releases = await fetchWithRetry("index.json", fetchFn, async (response) => {
    if (!response.ok) {
      throw new Error(
        `failed to resolve Node ${NODE_MAJOR} runtime version: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Array<{ version?: unknown; lts?: unknown }>;
  });
  const release = releases.find(
    (candidate) =>
      typeof candidate.version === "string" &&
      candidate.version.startsWith(`v${NODE_MAJOR}.`) &&
      candidate.lts,
  );
  if (typeof release?.version !== "string") {
    throw new Error(`failed to resolve latest Node ${NODE_MAJOR} LTS release`);
  }
  return release.version;
}

function normalizeNodeVersion(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

async function downloadFile(
  distPath: string,
  destination: string,
  fetchFn: typeof fetch,
): Promise<void> {
  // What the attempts so far received; a later attempt asks for the rest.
  let chunks: Uint8Array[] = [];
  let received = 0;
  const payload = await fetchWithRetry(
    distPath,
    fetchFn,
    async (response, onData) => {
      const range = contentRange(response);
      let size: number | undefined;
      if (response.status === 200) {
        chunks = [];
        received = 0;
        size = Number(response.headers.get("content-length") ?? Number.NaN);
      } else if (response.status === 206 && range?.start === received) {
        size = range.size;
      } else {
        chunks = [];
        received = 0;
        throw new Error(`download failed: ${response.url} returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error(`download failed: ${response.url} returned no body`);
      for await (const chunk of response.body) {
        chunks.push(chunk);
        received += chunk.length;
        onData();
      }
      if (Number.isFinite(size) && received !== size) {
        throw new Error(`download ended after ${received} of ${size} bytes`);
      }
      return Buffer.concat(chunks);
    },
    () => (received > 0 ? { range: `bytes=${received}-` } : {}),
  );
  await fs.writeFile(destination, payload);
}

/** The first byte and the file's size from a 206's `bytes <first>-<last>/<size>`. */
function contentRange(response: Response): { start: number; size: number } | undefined {
  const match = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return match ? { start: Number(match[1]), size: Number(match[2]) } : undefined;
}

// A download from nodejs.org has stalled in CI, for half an hour before the
// socket reset and again on each retry of the same URL. So an attempt that
// goes without data for a while is dropped, each attempt has a deadline, and
// the next attempt asks for the file under nodejs.org's other path, for only
// the bytes the attempts before it did not get.
const FETCH_ATTEMPTS = 4;
const FETCH_STALL_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

async function fetchWithRetry<T>(
  distPath: string,
  fetchFn: typeof fetch,
  read: (response: Response, onData: () => void) => Promise<T>,
  headers: () => Record<string, string> = () => ({}),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const url = `${NODE_DIST_BASE_URLS[(attempt - 1) % NODE_DIST_BASE_URLS.length]}/${distPath}`;
    const stalled = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => stalled.abort(new Error(`no data for ${FETCH_STALL_TIMEOUT_MS / 1000}s`)),
        FETCH_STALL_TIMEOUT_MS,
      );
    };
    onData();
    try {
      const response = await fetchFn(url, {
        headers: headers(),
        signal: AbortSignal.any([stalled.signal, AbortSignal.timeout(FETCH_ATTEMPT_TIMEOUT_MS)]),
      });
      return await read(response, onData);
    } catch (error) {
      if (attempt >= FETCH_ATTEMPTS) throw error;
      console.warn(
        `fetch ${url} failed (attempt ${attempt} of ${FETCH_ATTEMPTS}): ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(stallTimer);
    }
  }
}

function nodeDistPlatform(target: AgentArtifactPlatform): string {
  const os = target.os;
  const arch = target.arch === "amd64" ? "x64" : "arm64";
  return `${os}-${arch}`;
}

/**
 * package.json의 version을 읽어 에이전트 버전 기본값으로 쓴다. 읽거나 파싱에
 * 실패하면 undefined를 돌려 호출부가 DEFAULT_VERSION으로 폴백하게 한다.
 */
async function readAppVersion(rootDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function fileMetadata(filePath: string): Promise<{ sha256: string; size: number }> {
  const stat = await fs.stat(filePath);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size: stat.size };
}

function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

function parseCliArgs(argv: readonly string[]): BuildAgentDistributionOptions {
  const options: {
    rootDir?: string;
    outDir?: string;
    version?: string;
    protocolVersion?: string;
    nodeVersion?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      options.outDir = path.resolve(requiredValue(argv, ++index, arg));
    } else if (arg === "--version") {
      options.version = requiredValue(argv, ++index, arg);
    } else if (arg === "--protocol-version") {
      options.protocolVersion = requiredValue(argv, ++index, arg);
    } else if (arg === "--node-version") {
      options.nodeVersion = normalizeNodeVersion(requiredValue(argv, ++index, arg)) ?? undefined;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // CI keys its cache of the Node runtimes by the version this prints.
  const task =
    argv[0] === "--print-node-version"
      ? nodeRuntimeVersion(fetch).then((nodeVersion) => console.log(nodeVersion))
      : buildAgentDistribution(parseCliArgs(argv));
  task.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
