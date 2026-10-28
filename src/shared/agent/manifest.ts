import { z } from "zod";

/** The hosts an SSH workspace runs on. */
export const SshHostOsSchema = z.enum(["linux", "darwin"]);
/** Agent builds: the SSH hosts, plus Windows, where the agent serves only the local app. */
export const AgentArtifactOsSchema = z.enum([...SshHostOsSchema.options, "windows"]);
export const AgentArtifactArchSchema = z.enum(["amd64", "arm64"]);

export const AgentArtifactPlatformSchema = z.object({
  os: AgentArtifactOsSchema,
  arch: AgentArtifactArchSchema,
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ArtifactSizeSchema = z.number().int().nonnegative();

export const AgentBinaryManifestEntrySchema = AgentArtifactPlatformSchema.extend({
  path: z.string().min(1),
  sha256: Sha256Schema,
  size: ArtifactSizeSchema,
});

export const NodeRuntimeManifestEntrySchema = AgentArtifactPlatformSchema.extend({
  version: z.string().min(1),
  path: z.string().min(1),
  sha256: Sha256Schema,
  size: ArtifactSizeSchema,
  entry: z.string().min(1),
});

export const LspBinaryManifestEntrySchema = z.object({
  name: z.string().min(1),
  packageName: z.string().min(1),
  version: z.string().min(1),
  languages: z.array(z.string().min(1)).min(1),
  path: z.string().min(1),
  sha256: Sha256Schema,
  size: ArtifactSizeSchema,
  entry: z.string().min(1),
  launcher: z.string().min(1),
  argsTemplate: z.array(z.string()),
});

export const WrapperManifestEntrySchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  size: ArtifactSizeSchema,
});

export const AgentManifestSchema = z.object({
  version: z.string().min(1),
  protocolVersion: z.string().min(1),
  binaries: z.array(AgentBinaryManifestEntrySchema).min(1),
  runtime: z.object({
    node: z.array(NodeRuntimeManifestEntrySchema).min(1),
  }),
  lspBinaries: z.array(LspBinaryManifestEntrySchema),
  wrapper: z.optional(WrapperManifestEntrySchema),
});

export type SshHostOs = z.infer<typeof SshHostOsSchema>;
export type AgentArtifactPlatform = z.infer<typeof AgentArtifactPlatformSchema>;
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type AgentBinaryManifestEntry = z.infer<typeof AgentBinaryManifestEntrySchema>;
export type NodeRuntimeManifestEntry = z.infer<typeof NodeRuntimeManifestEntrySchema>;
export type LspBinaryManifestEntry = z.infer<typeof LspBinaryManifestEntrySchema>;
export type WrapperManifestEntry = z.infer<typeof WrapperManifestEntrySchema>;

export function findAgentBinary(
  manifest: AgentManifest,
  platform: AgentArtifactPlatform,
): AgentBinaryManifestEntry | undefined {
  return manifest.binaries.find(
    (candidate) => candidate.os === platform.os && candidate.arch === platform.arch,
  );
}

export function findNodeRuntime(
  manifest: AgentManifest,
  platform: AgentArtifactPlatform,
): NodeRuntimeManifestEntry | undefined {
  return manifest.runtime.node.find(
    (candidate) => candidate.os === platform.os && candidate.arch === platform.arch,
  );
}

export function findLspBinary(
  manifest: AgentManifest,
  query: { readonly name?: string; readonly languageId?: string },
): LspBinaryManifestEntry | undefined {
  return manifest.lspBinaries.find((candidate) => {
    const nameMatches = !query.name || candidate.name === query.name;
    const languageMatches = !query.languageId || candidate.languages.includes(query.languageId);
    return nameMatches && languageMatches;
  });
}
