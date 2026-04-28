# NOTICE

이 파일은 Plan #31의 VS Code급 파일트리·탭·검색·Source Control 격상에서 새로 도입하거나 번들링할 OSS attribution을 기록한다. 기존 의존성의 전체 목록과 라이선스는 `packages/*/package.json` 및 각 패키지의 lockfile/배포 산출물에서 확인한다.

## 새 OSS attribution

| Component | 용도 | License / attribution |
|---|---|---|
| `vscode-icons-js` | 파일·폴더 이름에서 VSCode Icons SVG 파일명을 매핑 | MIT. Repository: <https://github.com/dderevjanik/vscode-icons-js> |
| `vscode-icons` SVG assets | 파일 트리·에디터 탭·브레드크럼의 파일 타입 식별 아이콘 | Icons: CC BY-SA 4.0. Source code: MIT. Branded icons: 각 브랜드의 copyright/trademark 조건을 따른다. Primary source: <https://github.com/vscode-icons/vscode-icons#license> |
| `react-arborist` | File tree 가상화, tree interaction, DnD 기반 | MIT. Repository: <https://github.com/brimdata/react-arborist> |
| `react-dnd` | `react-arborist`의 DnD 전이 의존성 | MIT. Repository: <https://github.com/react-dnd/react-dnd> |
| `react-window` | `react-arborist`의 가상화 전이 의존성 | MIT. Repository: <https://github.com/bvaughn/react-window> |
| `@dnd-kit/core` | Editor tab drag-and-drop 기반 | MIT. Repository: <https://github.com/clauderic/dnd-kit> |
| `@dnd-kit/sortable` | Editor tab reorder/sortable 기반 | MIT. Repository: <https://github.com/clauderic/dnd-kit> |
| `shadcn/ui` | ContextMenu 등 UI primitive 조합 | MIT. Repository: <https://github.com/shadcn-ui/ui> |
| Radix UI ContextMenu | `shadcn/ui` ContextMenu primitive | MIT. Repository: <https://github.com/radix-ui/primitives> |
| `ripgrep` | sidecar bundled project-wide search binary | MIT OR Unlicense. 배포 NOTICE에서는 MIT 경로를 기준으로 attribution한다. Repository: <https://github.com/BurntSushi/ripgrep> |
| `vscode-languageserver-protocol` | Plan #29 LSP protocol 타입·메시지 표준 | MIT. Repository: <https://github.com/microsoft/vscode-languageserver-node> |

## vscode-icons SVG 라이선스 확인 결과

`vscode-icons/vscode-icons`의 README License 섹션은 source code를 MIT로, icons를 Creative Commons Attribution-ShareAlike 4.0 International(CC BY-SA 4.0)로, branded icons를 각 브랜드 copyright license로 구분한다. 따라서 이 저장소에서 SVG 자산을 번들링하거나 수정할 때는 CC BY-SA 4.0 attribution과 변경 표시를 유지해야 하며, branded icon은 별도 권리 조건을 침해하지 않도록 사용 범위를 검토한다.
