# empirical: LSP 서버는 agent의 env를 그대로 상속한다

## 관찰

`internal/lsp/server.go`의 `start()`는 spawn 시 `cmd.Env = os.Environ()`를 그대로 박는다. 즉 agent 프로세스의 환경 변수가 모든 LSP 서버에 그대로 흘러들어간다.

- 로컬: Electron main → agent → LSP 가 모두 같은 사용자 셸 env를 공유하므로 PATH/LANG 결손 가능성이 낮다.
- SSH: ssh-bootstrap이 `bash -lc`로 agent를 띄우긴 하지만, agent가 LSP를 spawn할 때는 `os.Environ()`을 그대로 쓴다. 원격 사용자가 .bashrc/.profile에 `export PATH=...`를 넣어둔 경우와 시스템 PATH만 있는 경우 결과가 달라진다.

## 왜 지금은 안 깨지는가

현재 두 LSP(typescript-language-server, pyright-langserver)는 모두 SSH bootstrap이 작성한 launcher 스크립트가 **Node 절대경로**를 박아넣고 실행한다 (`ssh-bootstrap.ts: writeRemoteLspLauncher`). PATH lookup이 필요 없어서 env 빈약 상황에서도 동작한다.

## 깨질 조건

다음 중 하나라도 추가되면 발현 가능:
- PATH lookup에 의존하는 LSP (rust-analyzer, gopls 같은 자체-실행형) 추가
- 환경변수 주도의 LSP 옵션 (`PYTHONPATH`, `GOPATH`, `JAVA_HOME` 등) 사용
- 사용자 별 분리된 npm prefix 가정

## 대응 옵션 (필요 시)

1. `lsp.spawn`에 optional `env` 필드를 추가하고 TS 측이 preset별로 명시 주입.
2. agent가 워크스페이스 root에 `.envrc` / `.env` 류를 발견하면 read-only 적용 (보안 검토 필요).
3. 원격 SSH agent를 `bash -lc 'agent ...'`로 띄우는 대신 launcher 스크립트가 명시적으로 PATH를 합성.

지금은 **현상만 기록하고 발현 시 1번 옵션을 우선 검토**한다.
