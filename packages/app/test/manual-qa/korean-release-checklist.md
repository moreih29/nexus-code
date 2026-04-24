# Task 12 — Manual QA Checklist (Signed macOS `.app` Korean Release Gate)

> **Status: MANUAL PENDING**
>
> This document is a runbook/template only. Do **not** mark release PASS from this file alone.
>
> Release stays blocked until a human run on **both arm64 and x64** is completed and evidence is recorded under `packages/app/test/manual-qa/release-evidence/`.

## 1) Hard release gate

Release is blocked unless all of the following are true:

1. `bun run test:ime-checklist` is PASS (automated deterministic gate).
2. This manual checklist is PASS on **macOS arm64** and **macOS x64** signed `.app` runs.
3. Evidence bundle exists at `packages/app/test/manual-qa/release-evidence/<RUN_ID>/` and release notes include its verdict.

## 2) Evidence bootstrap (before testing)

From `packages/app`:

```bash
RUN_ID="$(date +%F)_<build-id>"
EVIDENCE_DIR="test/manual-qa/release-evidence/${RUN_ID}"
mkdir -p "$EVIDENCE_DIR"/{arm64,x64}
cp test/manual-qa/release-evidence/manual-qa-evidence.template.md "$EVIDENCE_DIR/evidence.md"
cp test/manual-qa/release-evidence/release-notes-snippet.template.md "$EVIDENCE_DIR/release-notes-snippet.md"
cp test/manual-qa/release-evidence/korean-latency-samples.template.csv "$EVIDENCE_DIR/latency-samples.csv"
```

Fill metadata first in `evidence.md` (build id, git commit, tester, host/VM, macOS version, app path).

## 3) Execute on both architectures

Use the same checks below for each architecture:

- **arm64**: Apple Silicon macOS host/VM
- **x64**: Intel macOS host/VM

If either architecture has one FAIL item, release is blocked.

---

## 4) Checklist items

### S1. Signed `.app` Dock launch / trust chain

1. Set app path: `APP_PATH="/Applications/NexusCode.app"` (adjust if needed).
2. Verify signing and assessment:
   ```bash
   codesign --verify --deep --strict --verbose=2 "$APP_PATH"
   spctl --assess --type execute --verbose=4 "$APP_PATH"
   ```
3. Launch via Finder (double-click app).
4. Quit app, then relaunch from Dock icon.

Expected PASS:

- `codesign`/`spctl` commands exit `0`.
- App opens without quarantine/notarization warning dialogs.
- Dock launch/relaunch works (icon present, click opens app).

Evidence:

- `<arch>/S1-codesign.txt` (command outputs)
- `<arch>/S1-dock-launch.png` (Dock + running app window)

---

### E1. PATH / brew / node / mise sanity (inside app terminal)

> Run inside the Nexus terminal tab (not host Terminal.app).

```bash
echo "SHELL=$SHELL"
echo "PATH=$PATH"
for tool in brew node mise; do
  printf "%s=%s\n" "$tool" "$(command -v "$tool" || echo '<missing>')"
done
brew --version || true
node --version || true
mise --version || true
```

Expected PASS:

- `PATH` is non-empty and includes expected Homebrew prefix for the host arch (`/opt/homebrew/bin` on arm64, `/usr/local/bin` on x64).
- `brew`, `node`, `mise` resolve to real paths (or missing is explicitly approved in the run metadata as N/A baseline).

Evidence:

- `<arch>/E1-path-toolchain.txt`

---

### E2. Login env sanity (`PATH`, `LANG`, `NVM_DIR`)

Inside app terminal:

```bash
printf 'PATH=%s\nLANG=%s\nLC_ALL=%s\nNVM_DIR=%s\n' \
  "$PATH" "${LANG:-<unset>}" "${LC_ALL:-<unset>}" "${NVM_DIR:-<unset>}"
```

Expected PASS:

- `PATH` present and sane for the host.
- `LANG` is set to a UTF-8 locale.
- `NVM_DIR` is either set correctly, **or** explicitly marked as intentionally unset in evidence (e.g., using `mise` only).

Evidence:

- `<arch>/E2-login-env.txt`

---

### K0. Korean IME precondition (required for K1–K7)

Before K1–K7, switch input source to **macOS system Korean 2-beol (2-set)**.

- Menu bar input source must show Korean (2-set).
- Do not use third-party IME.

Record screenshot:

- `<arch>/K0-ime-source.png`

---

### K1. Composition cursor overlay alignment

1. In app terminal run `cat`.
2. While composing Hangul syllables (not yet committed), type at:
   - line start,
   - line middle,
   - near right edge (wrap boundary).

Expected PASS:

- Composition UI/cursor stays at the active caret position (no detached/floating mismatch).

Evidence:

- `<arch>/K1-composition-cursor.png`

---

### K2. Enter during composition (double-Enter guard)

1. At shell prompt, start composing Hangul (composition active).
2. Press **Enter once** during composition.
3. Press **Enter again**.

Expected PASS:

- First Enter commits composition only (no premature submit/command execution).
- Second Enter performs the actual submit/newline.

Evidence:

- `<arch>/K2-enter-guard.mov` (or `.mp4`)

---

### K3. Hangul width (`ㅎ`, `가`, general Hangul)

Run inside app terminal:

```bash
python3 - <<'PY'
samples = [("ㅎ", 2), ("가", 2), ("한글", 4), ("abc", 3)]
for text, expected_cells in samples:
    padding = 10 - expected_cells
    print(f"{text}{'.' * padding}|")
print("----------|  <- bars above should align")
PY
```

Expected PASS:

- The trailing `|` markers align vertically.
- This implies `ㅎ` and `가` render as double-width, and Hangul width behavior matches expectation.

Evidence:

- `<arch>/K3-hangul-width.png`

---

### K4. NFC path normalization (macOS NFD input path)

1. Create an NFD-named folder:
   ```bash
   python3 - <<'PY'
import unicodedata, pathlib
root = pathlib.Path.home() / "Desktop" / "nexus-ime-nfd"
root.mkdir(parents=True, exist_ok=True)
nfc = "한글-경로"
nfd = unicodedata.normalize("NFD", nfc)
p = root / nfd
p.mkdir(exist_ok=True)
print("NFC:", repr(nfc))
print("NFD:", repr(nfd))
print("PATH:", p)
PY
   ```
2. Open that folder as a workspace in the app.
3. Check persisted registry path normalization:
   ```bash
   REGISTRY_FILE="$HOME/Library/Application Support/NexusCode/workspace-registry.v1.json"
   python3 - <<'PY'
import json, pathlib, unicodedata, os
p = pathlib.Path(os.environ["REGISTRY_FILE"]).expanduser()
data = json.loads(p.read_text(encoding="utf-8"))
non_nfc = [ws["absolutePath"] for ws in data.get("workspaces", [])
           if ws.get("absolutePath") != unicodedata.normalize("NFC", ws.get("absolutePath", ""))]
print("non_nfc_count=", len(non_nfc))
for item in non_nfc:
    print("NON_NFC", repr(item))
PY
   ```

Expected PASS:

- `non_nfc_count= 0`.

Evidence:

- `<arch>/K4-nfc-check.txt`

---

### K5. No dropped chars during composition buffering

1. Run: `cat > /tmp/nexus-ime-no-drop.txt`
2. With Korean 2-beol IME, manually type this phrase **10 times** without paste:
   - `가나다라마바사아자차카타파하`
3. Press Enter, then `Ctrl+D`.
4. Verify exact match:
   ```bash
   python3 - <<'PY'
from pathlib import Path
target = "가나다라마바사아자차카타파하" * 10
actual = Path("/tmp/nexus-ime-no-drop.txt").read_text(encoding="utf-8").strip()
print("target_len=", len(target))
print("actual_len=", len(actual))
print("exact_match=", actual == target)
PY
   ```

Expected PASS:

- `exact_match= True`.

Evidence:

- `<arch>/K5-no-drop.txt`

---

### K6. Input→echo→paint latency (<16ms average)

1. Record the keyboard + screen at **>=120fps** while entering Hangul in app terminal.
2. Capture at least 10 keypress samples.
3. For each sample compute: `latency_ms = frame_delta * (1000 / fps)`.
4. Write samples into `latency-samples.csv`.

Expected PASS:

- Average latency `< 16ms`.

Evidence:

- `<arch>/K6-latency-video.mov` (or `.mp4`)
- `<RUN_ID>/latency-samples.csv`

---

### K7. Font fallback stack includes D2Coding + Noto Sans KR

1. Open terminal with Hangul + ASCII visible.
2. Open DevTools (`Cmd+Opt+I`) and inspect terminal element/computed font-family.
3. Confirm stack includes `"D2Coding"` then `"Noto Sans KR"`.

Expected PASS:

- Both fonts are present in order in resolved/default terminal font stack.

Evidence:

- `<arch>/K7-font-stack.png`

---

### T1. Scrollback FIFO behavior (no silent boundary loss)

1. Flood terminal output with monotonic ids:
   ```bash
   python3 - <<'PY'
for i in range(1, 150001):
    print(f"FIFO-{i:06d}")
PY
   ```
2. Use search (`Cmd+F` / `Ctrl+F`) for `FIFO-000001`, then for `FIFO-150000`.
3. Confirm older ids eventually disappear while newest ids remain searchable.

Expected PASS:

- Oldest lines are dropped first (FIFO characteristic).
- Search for very old id reaches boundary/no-match while tail id is still found.
- Any unexpected random mid-range loss should be marked FAIL.

Evidence:

- `<arch>/T1-scrollback-fifo.png`
- `<arch>/T1-scrollback-notes.txt`

---

### T2. Copy-on-select + Cmd/Ctrl+C/V

1. Print a token: `printf 'COPY_TOKEN_12345\n'`
2. Mouse-select token.
3. Verify copy-on-select by pasting to another app.
4. Back in app terminal, test:
   - `Cmd+C` / `Ctrl+C` with selection (copy)
   - `Cmd+V` / `Ctrl+V` paste into `cat` session.

Expected PASS:

- Selection auto-copies.
- Shortcut copy/paste works and pasted content matches selected token.

Evidence:

- `<arch>/T2-copy-paste.mov`

---

### T3. Ctrl/Cmd+F search boundary semantics

1. Run:
   ```bash
   printf 'BOUNDARY_NEEDLE\nmid\nBOUNDARY_NEEDLE\n'
   ```
2. Open search (`Cmd+F` or `Ctrl+F`), query `BOUNDARY_NEEDLE`.
3. Navigate next until boundary.
4. Navigate previous once.

Expected PASS:

- Search reaches end and shows boundary/no-more-matches state.
- Previous navigation recovers to prior match.

Evidence:

- `<arch>/T3-search-boundary.png`

---

## 5) Completion rule (release blocker)

Do not mark release ready until:

- Every check row (S1, E1, E2, K1..K7, T1..T3) is PASS on **arm64 and x64**.
- `evidence.md` verdict is PASS.
- `release-notes-snippet.md` is filled with the final verdict + evidence path.

If any item is FAIL/PENDING/N/A-without-approval, release remains blocked.
