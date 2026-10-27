// Points @monaco-editor/react's loader at the copy of monaco-editor shipped
// with the app instead of its default jsDelivr CDN, so the editor loads
// without network. monacoAssetsPlugin (electron.vite.config.ts) serves that
// copy at `monaco/vs` next to index.html, in dev and in the build.
//
// Must run before anything mounts an editor or calls useMonaco(): the loader
// reads its config once, on the first init.

import { loader } from "@monaco-editor/react";

loader.config({ paths: { vs: new URL("monaco/vs", document.baseURI).href } });
