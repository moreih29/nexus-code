package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// plainDiff is a turn diff codex 0.166 wrote on Windows, in a folder that is
// not a repository: a CRLF file, a deleted file, a Korean one, a file whose
// last line had no ending (apply_patch gives it one), and a new file.
const plainDiff = "diff --git a/crlf.txt b/crlf.txt\nindex b4ec4d1f30d56e5f6c7f71191766764535a9b2e2..c6d393ec67e49ae1e8f3c2a8d9431150f7eecd95\n--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,3 +1,3 @@\n alpha\r\n-beta\r\n+BETA\r\n gamma\r\n" +
	"diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex b023018cabc396e7692c70bbf5784a93d3f738ab..0000000000000000000000000000000000000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n" +
	"diff --git a/ko.txt b/ko.txt\nindex e09372cb40acc52a6501c6241d062cda9ab19546..99c17a748700256cdb463ec255ee5a756538353b\n--- a/ko.txt\n+++ b/ko.txt\n@@ -1,2 +1,2 @@\n 한글\n-둘째\n+셋째\n" +
	"diff --git a/lf.txt b/lf.txt\nindex 54d55bf0bb50b503792f391b6f0158bd6145073e..ddc897f039f57aa91e16efa6dfde386c4255206f\n--- a/lf.txt\n+++ b/lf.txt\n@@ -1,3 +1,3 @@\n one\n-two\n-three\n\\ No newline at end of file\n+TWO\n+three\n" +
	"diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..ce013625030ba8dba906f756967f9e9ca394464a\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n"

// plainAfter is the folder as that turn left it.
var plainAfter = map[string]string{
	"crlf.txt": "alpha\r\nBETA\r\ngamma\r\n",
	"ko.txt":   "한글\n셋째\n",
	"lf.txt":   "one\nTWO\nthree\n",
	"new.txt":  "hello\n",
}

func diffLine(t *testing.T, diff string) []byte {
	t.Helper()
	line, err := json.Marshal(map[string]any{
		"method": "turn/diff/updated",
		"params": map[string]any{"threadId": "th", "turnId": "tu", "diff": diff},
	})
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// outsideRepo makes snapshots for a folder taken as no repository's, so a
// temp folder inside one tests the same.
func outsideRepo(dir string) *snapshots {
	s := newSnapshots(dir)
	s.roots = []string{dir}
	return s
}

func originals(snaps []snapshot) map[string]any {
	got := map[string]any{}
	for _, snap := range snaps {
		if snap.Event != "snapshot" {
			got[snap.Path] = "event " + snap.Event
		} else if snap.Before == nil {
			got[snap.Path] = nil
		} else {
			got[snap.Path] = *snap.Before
		}
	}
	return got
}

func TestSnapshotsTakeEachFileBeforeTheTurn(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, plainAfter)
	s := outsideRepo(dir)

	got := originals(s.take(diffLine(t, plainDiff)))
	want := map[string]any{
		filepath.Join(dir, "crlf.txt"): "alpha\r\nbeta\r\ngamma\r\n",
		filepath.Join(dir, "gone.txt"): "bye\n",
		filepath.Join(dir, "ko.txt"):   "한글\n둘째\n",
		filepath.Join(dir, "lf.txt"):   "one\ntwo\nthree",
		filepath.Join(dir, "new.txt"):  nil,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("originals = %q, want %q", got, want)
	}
	if again := s.take(diffLine(t, plainDiff)); len(again) != 0 {
		t.Fatalf("taken twice: %v", originals(again))
	}
}

func TestSnapshotsWaitForTheFileTheDiffMade(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, plainAfter)
	// Patched again before the agent read it.
	writeFiles(t, dir, map[string]string{"crlf.txt": "alpha\r\nBETA\r\nGAMMA\r\n"})
	s := outsideRepo(dir)

	if got := originals(s.take(diffLine(t, plainDiff))); got[filepath.Join(dir, "crlf.txt")] != nil {
		t.Fatalf("taken from a file the diff did not make: %q", got)
	}
	// The turn's next diff matches the file again.
	writeFiles(t, dir, map[string]string{"crlf.txt": plainAfter["crlf.txt"]})
	got := originals(s.take(diffLine(t, plainDiff)))
	if got[filepath.Join(dir, "crlf.txt")] != "alpha\r\nbeta\r\ngamma\r\n" || len(got) != 1 {
		t.Fatalf("originals = %q", got)
	}
}

func TestSnapshotsGiveUpOnAFileALaterTurnChanged(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"crlf.txt": "edited meanwhile\r\n"})
	s := outsideRepo(dir)
	s.take(diffLine(t, plainDiff))

	// The second turn's diff starts from the first turn's file, not the original.
	second := "diff --git a/crlf.txt b/crlf.txt\nindex c6d393ec67e49ae1e8f3c2a8d9431150f7eecd95..aa6b03c701602a7f29937dd99173906d8a68a8ba\n--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,3 +1,3 @@\n alpha\r\n BETA\r\n-gamma\r\n+GAMMA\r\n"
	writeFiles(t, dir, map[string]string{"crlf.txt": "alpha\r\nBETA\r\nGAMMA\r\n"})
	if got := s.take(diffLine(t, second)); len(got) != 0 {
		t.Fatalf("took a later turn's start for the original: %q", originals(got))
	}
}

func TestSnapshotsReadPathsFromTheRepositoryRoot(t *testing.T) {
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(repo, "sub")
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %d\n", i+1)
	}
	original := strings.Join(lines, "")
	writeFiles(t, cwd, map[string]string{
		"long.txt":     strings.Replace(original, "line 10\n", "LINE TEN\n", 1),
		"new-name.txt": "move me\n",
	})
	s := newSnapshots(cwd)
	if got := s.rootsOf(); !reflect.DeepEqual(got, []string{repo, cwd}) {
		t.Fatalf("roots = %v", got)
	}

	// As codex wrote it with its folder in a repository's sub folder.
	diff := "diff --git a/sub/long.txt b/sub/long.txt\nindex c4352f8b46de5cdb88d0cc96958316db42dd2398..66642de857bd6701d3aa63930159245a5d3e3dd9\n--- a/sub/long.txt\n+++ b/sub/long.txt\n@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+LINE TEN\n line 11\n line 12\n line 13\n" +
		"diff --git a/sub/old-name.txt b/sub/new-name.txt\nindex d3f59cb83812926b440d3cd7ef80c168183157e1..d3f59cb83812926b440d3cd7ef80c168183157e1\n--- a/sub/old-name.txt\n+++ b/sub/new-name.txt\n"
	got := originals(s.take(diffLine(t, diff)))
	want := map[string]any{filepath.Join(cwd, "long.txt"): original}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("originals = %q, want %q (a moved file is left out)", got, want)
	}
}

func TestSnapshotsKeepOnlyTextThatFits(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("x", snapshotFileCap) + "\n"
	files := map[string][2]string{
		"big.txt":    {big + "a\n", big + "b\n"},
		"latin1.txt": {"caf\xe9\na\n", "caf\xe9\nb\n"},
		"small.txt":  {"a\n", "b\n"},
	}
	var diff strings.Builder
	for name, sides := range files {
		before, after := sides[0], sides[1]
		writeFiles(t, dir, map[string]string{name: after})
		n := strings.Count(before, "\n")
		fmt.Fprintf(&diff, "diff --git a/%s b/%s\nindex %s..%s\n--- a/%s\n+++ b/%s\n@@ -%d +%d @@\n-a\n+b\n",
			name, name, blobHash(before), blobHash(after), name, name, n, n)
	}
	got := originals(outsideRepo(dir).take(diffLine(t, diff.String())))
	want := map[string]any{filepath.Join(dir, "small.txt"): "a\n"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("originals = %q, want %q", got, want)
	}
}

func TestReverseDiffAtTheFilesEnds(t *testing.T) {
	cases := []struct {
		name, before, after, diff string
	}{
		{"emptied", "a\nb\n", "", "@@ -1,2 +0,0 @@\n-a\n-b\n"},
		{"filled", "", "x\n", "@@ -0,0 +1 @@\n+x\n"},
		{"no ending kept", "a\nb", "a\nB", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"},
		{"two hunks", "1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\nX\n3\n4\n5\n6\n7\nY\n9\n", "@@ -1,3 +1,3 @@\n 1\n-2\n+X\n 3\n@@ -7,3 +7,3 @@\n 7\n-8\n+Y\n 9\n"},
	}
	for _, c := range cases {
		files := parseDiff("diff --git a/f b/f\nindex 1111111..2222222\n--- a/f\n+++ b/f\n" + c.diff)
		if len(files) != 1 {
			t.Fatalf("%s: %d files", c.name, len(files))
		}
		got, ok := files[0].before(c.after)
		if !ok || got != c.before {
			t.Fatalf("%s: before = %q, %v; want %q", c.name, got, ok, c.before)
		}
	}
	files := parseDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n")
	if _, ok := files[0].before("c\n"); ok {
		t.Fatal("reversed a diff the file does not have")
	}
}

func TestBlobHashIsGits(t *testing.T) {
	// git hash-object --no-filters of each.
	for text, want := range map[string]string{
		"":                           "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
		"alpha\r\nbeta\r\ngamma\r\n": "b4ec4d1f30d56e5f6c7f71191766764535a9b2e2",
		"one\ntwo\nthree":            "54d55bf0bb50b503792f391b6f0158bd6145073e",
	} {
		if got := blobHash(text); got != want {
			t.Fatalf("blobHash(%q) = %s, want %s", text, got, want)
		}
	}
}

func TestLogCapKeepsPinnedLines(t *testing.T) {
	log := newLineLog()
	log.cap = 1000
	log.add(DirOut, json.RawMessage(`{"type":"assistant","n":0}`), "")
	pinned := log.addPinned(DirSys, json.RawMessage(`{"event":"snapshot"}`))
	for i := 1; i < 50; i++ {
		log.add(DirOut, json.RawMessage(fmt.Sprintf(`{"type":"assistant","n":%d}`, i)), "")
	}
	entries := log.since(0)
	if !log.truncated || entries[0] != pinned || entries[1].seq == 1 {
		t.Fatalf("truncated %v, first lines %s, %s", log.truncated, entries[0].message, entries[1].message)
	}
	if log.bytes > log.cap {
		t.Fatalf("bytes %d over the cap", log.bytes)
	}
	log.reset()
	if len(log.since(0)) != 0 {
		t.Fatal("reset kept a pinned line")
	}
}

func TestAProgramsTurnDiffLogsTheOriginalForReplay(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	cwd := t.TempDir()
	writeFiles(t, cwd, map[string]string{"crlf.txt": plainAfter["crlf.txt"]})
	diff := plainDiff[:strings.Index(plainDiff, "diff --git a/gone.txt")]
	env := map[string]string{"NEXUS_CHAT_FAKE_LINE": string(diffLine(t, diff))}
	startFakeWith(t, service, "tab", env, func(p *StartParams) { p.Cwd = cwd })
	if err := send(t, service, "tab", "line"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	want := fmt.Sprintf(`{"event":"snapshot","path":%q,"before":"alpha\r\nbeta\r\ngamma\r\n"}`,
		filepath.Join(cwd, "crlf.txt"))
	isSnapshot := func(line LinePayload) bool {
		return line.Dir == DirSys && string(line.Message) == want
	}
	rec.waitFor(t, "the original", func(lines []LinePayload, _ []ExitPayload) bool {
		for _, line := range lines {
			if isSnapshot(line) {
				return true
			}
		}
		return false
	})

	rec.reset()
	params, _ := json.Marshal(ReplayParams{WorkspaceID: "ws", TabID: "tab"})
	if _, err := service.Replay(context.Background(), params); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for i, line := range rec.lines {
		if isSnapshot(line) {
			if i == 0 || !strings.Contains(string(rec.lines[i-1].Message), diffMethod) {
				t.Fatalf("the original does not follow its diff: %s", describe(rec.lines))
			}
			return
		}
	}
	t.Fatalf("replay without the original: %s", describe(rec.lines))
}
