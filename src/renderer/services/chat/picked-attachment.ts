import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import type { PickedAttachment } from "../../../shared/fs/picked-attachment";

interface PreparedAttachment {
  file: File;
  unbufferedSize?: number;
  image?: string;
}

export async function prepareLongPathAttachment(
  file: File,
  imageLimit: number,
  recover: (file: File) => Promise<PickedAttachment | null>,
): Promise<PreparedAttachment> {
  if (file.size > 0) {
    if (file.size <= imageLimit) {
      const image = await base64Of(file).catch(() => null);
      if (image) return { file, image };
    } else {
      const sample = file.size > MAX_READABLE_FILE_SIZE ? file.slice(0, 1) : file;
      const contents = await sample.arrayBuffer().catch(() => null);
      if (contents?.byteLength === sample.size) return { file };
    }
  }
  const result = await recover(file);
  if (!result) throw new Error("Attachment could not be read");
  const { size, bytes } = result;
  if (!bytes) return { file, unbufferedSize: size };
  const recovered = new File([bytes], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
  if (size > 0 && size <= imageLimit) return { file: recovered, image: await base64Of(recovered) };
  return { file: recovered };
}

export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
