import { loader } from "@monaco-editor/react";

loader.config({ paths: { vs: new URL("monaco/vs", document.baseURI).href } });
