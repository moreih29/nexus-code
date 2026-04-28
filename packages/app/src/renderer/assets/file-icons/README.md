# File icon SVG assets

Subset of SVG assets from the MIT-licensed [vscode-icons](https://github.com/vscode-icons/vscode-icons) project, used through `components/file-icon/` only.

These files are loaded lazily by Vite via `import.meta.glob(..., { query: "?raw", import: "default" })` so packaged Electron builds do not depend on runtime filesystem access for renderer icons.
