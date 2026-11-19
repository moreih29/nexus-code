/**
 * Fetches the full-precision voice print model for a Windows or Linux build
 * into dist/voice-print (electron-builder.yml takes it from there): the
 * sherpa-onnx export of 3D-Speaker's CAM++, checked against its SHA-256. A
 * Mac build ships the 8-bit model kept in resources/voice-print instead
 * (src/main/features/voice-print). Does nothing when the file is there.
 *
 *   bun run scripts/voice-print-model.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The sherpa-onnx maintainer's Hugging Face copy, pinned to a commit: the
// GitHub release asset of the same name was replaced on 2026-11-19 by a
// re-export (AveragePool count_include_pad 1 -> 0), which changes the model's
// output. This commit holds the export the app has always shipped.
const URL =
  "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
const SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2";
const DIR = join(import.meta.dir, "..", "dist", "voice-print");
const FILE = join(DIR, "campp-zh-en.onnx");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

if (existsSync(FILE) && sha256(readFileSync(FILE)) === SHA256) {
  console.log(`voice print model: ${FILE} is there`);
  process.exit(0);
}
mkdirSync(DIR, { recursive: true });
const response = await fetch(URL);
if (!response.ok) throw new Error(`voice print model: ${response.status} from ${URL}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const got = sha256(bytes);
if (got !== SHA256) throw new Error(`voice print model: SHA-256 ${got}, not ${SHA256}`);
writeFileSync(`${FILE}.part`, bytes);
renameSync(`${FILE}.part`, FILE);
console.log(`voice print model: fetched ${FILE} (${(bytes.length / 1e6).toFixed(1)} MB)`);
