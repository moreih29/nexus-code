import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
