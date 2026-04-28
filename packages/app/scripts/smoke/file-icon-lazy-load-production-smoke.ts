import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "vite";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(import.meta.dir, "../..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-file-icon-lazy-load-"));
const outDir = path.join(tempRoot, "dist");
const entryPath = path.join(tempRoot, "entry.ts");
const fileIconLoaderPath = path
  .resolve(appRoot, "src/renderer/components/file-icon/file-icon-loader.ts")
  .split(path.sep)
  .join(path.posix.sep);

try {
  await writeFile(
    entryPath,
    `import { loadFileIconSvg } from ${JSON.stringify(fileIconLoaderPath)};\n\n` +
      `const defaultSvg = await loadFileIconSvg("default_file.svg");\n` +
      `const pythonSvg = await loadFileIconSvg("file_type_python.svg");\n\n` +
      `if (!defaultSvg.trim().startsWith("<svg")) {\n` +
      `  throw new Error("default_file.svg did not lazy-load as SVG text");\n` +
      `}\n` +
      `if (!pythonSvg.includes("file_type_python")) {\n` +
      `  throw new Error("file_type_python.svg did not lazy-load through the production bundle");\n` +
      `}\n` +
      `console.log("file-icon production lazy-load entry passed");\n`,
  );

  await build({
    configFile: false,
    logLevel: "silent",
    root: tempRoot,
    build: {
      emptyOutDir: true,
      outDir,
      rollupOptions: {
        input: entryPath,
        output: {
          chunkFileNames: "chunks/[name]-[hash].mjs",
          entryFileNames: "entry.mjs",
        },
      },
      target: "esnext",
    },
  });

  const { stdout } = await execFileAsync(process.execPath, [path.join(outDir, "entry.mjs")], {
    cwd: outDir,
  });

  if (!stdout.includes("file-icon production lazy-load entry passed")) {
    throw new Error(`Unexpected file icon lazy-load smoke output: ${stdout}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("file-icon production lazy-load smoke passed");
