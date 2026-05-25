import { execFileSync } from "node:child_process";

/**
 * macOS GUI 앱은 launchd가 시작하면서 PATH가 시스템 기본값
 * (`/usr/bin:/bin:/usr/sbin:/sbin`)만 받는다. 터미널 / iTerm / `bun run dev`로
 * 띄울 때는 부모 프로세스가 이미 사용자 shell PATH를 갖고 있어서 자식이
 * 그것을 상속받지만, packaged 앱은 빈약한 PATH를 그대로 자식(PTY shell, ssh,
 * sftp 등)에 넘긴다. 결과적으로 `.zshrc`가 `~/.local/bin/uv`나
 * `/opt/homebrew/bin/...`를 호출할 때 `command not found`가 나거나, ssh가
 * 사용자 ssh_config의 ProxyCommand를 못 찾는 등 사소한 마찰이 광범위하게
 * 발생한다.
 *
 * 부팅 시 한 번 사용자 login+interactive shell을 호출해 `$PATH`를 가져와
 * `process.env.PATH`에 박는다. 이후 모든 child_process / pty / ssh 자식이
 * 이 PATH를 상속한다.
 *
 * `-ilc`:
 * - `-l` login shell — `.zprofile` / `.bash_profile` / `.profile` 로딩
 * - `-i` interactive shell — `.zshrc` / `.bashrc` 로딩
 * - `-c` 단일 명령 실행 후 종료
 *
 * 5초 타임아웃: 사용자 shell 초기화가 비정상적으로 느릴 때(예: 원격 마운트
 * 의존 rc 파일) 부팅을 지연시키지 않기 위함. 타임아웃·실패 시 기존 PATH를
 * 유지하고 조용히 진행한다 (degrade gracefully).
 *
 * 호출 시점: `app.isPackaged === true`이고 darwin/linux에서만. dev 모드는
 * 이미 부모 shell PATH가 살아 있어서 동기화 불필요(또한 부팅 지연 회피).
 */
export function syncUserShellPath(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;

  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    // `printf %s "$PATH"` 사용 — trailing newline 제거. echo는 zsh/bash에 따라
    // 다르게 동작할 수 있어서 회피.
    const output = execFileSync(shell, ["-ilc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      // stderr는 무시: `.zshrc` 안에서 `command not found` 같은 메시지가 나도
      // PATH 출력에는 영향 없음.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    if (trimmed.length > 0 && trimmed !== process.env.PATH) {
      process.env.PATH = trimmed;
    }
  } catch {
    // 타임아웃, shell 실행 실패, 기타 — 기본 PATH 유지.
  }
}
