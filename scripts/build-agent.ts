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
const NODE_MAJOR = 20;
const NODE_DIST_BASE_URL = "https://nodejs.org/dist";

export const AGENT_BUILD_TARGETS = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
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
    options.nodeVersion ??
    normalizeNodeVersion(process.env.NODE_RUNTIME_VERSION ?? "") ??
    (await resolveLatestNode20Version(dependencies.fetch ?? fetch));
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
    const name = `agent-${args.version}-${target.os}-${target.arch}`;
    await args.run(
      "go",
      [
        "build",
        "-tags=netgo,osusergo",
        "-ldflags=-s -w",
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

  for (const target of AGENT_BUILD_TARGETS) {
    const platform = nodeDistPlatform(target);
    const archive = `node-${args.nodeVersion}-${platform}.tar.gz`;
    const relativePath = path.join("runtime", archive);
    const url = `${NODE_DIST_BASE_URL}/${args.nodeVersion}/${archive}`;
    await downloadFile(url, path.join(args.outDir, relativePath), fetchFn);
    artifacts.push({
      ...target,
      version: args.nodeVersion,
      path: relativePath,
      entry: "bin/node",
    });
  }

  return artifacts;
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
    await args.run("tar", ["-czf", path.join(lspOutDir, archiveName), "-C", extractedDir, "."], {
      cwd: args.rootDir,
    });
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

async function resolveLatestNode20Version(fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(`${NODE_DIST_BASE_URL}/index.json`);
  if (!response.ok) {
    throw new Error(
      `failed to resolve Node ${NODE_MAJOR} runtime version: HTTP ${response.status}`,
    );
  }
  const releases = (await response.json()) as Array<{ version?: unknown; lts?: unknown }>;
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
  url: string,
  destination: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`download failed: ${url} returned HTTP ${response.status}`);
  }
  const payload = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, payload);
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
  buildAgentDistribution(parseCliArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
