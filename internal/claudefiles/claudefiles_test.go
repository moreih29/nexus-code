package claudefiles

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/filelink"
)

const session = "0123456789abcdef"

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

type folderLink struct {
	name string
	make func(target, link string) error
}

func folderLinks() []folderLink {
	links := []folderLink{{"symlink", os.Symlink}}
	if runtime.GOOS == "windows" {
		links = append(links, folderLink{"junction", filelink.Junction})
	}
	return links
}

func makeLink(t *testing.T, link folderLink, target, path string) {
	t.Helper()
	if err := link.make(target, path); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("no %s here: %v", link.name, err)
		}
		t.Fatal(err)
	}
}

func TestOpenReadsAFileFoundUnderTheProjectsFolder(t *testing.T) {
	projects := filepath.Join(t.TempDir(), "projects")
	path := filepath.Join(projects, "p", session+".jsonl")
	write(t, path, "mine\n")
	want, ok := RegularFile(path)
	if !ok {
		t.Fatal("the session file is not a regular file")
	}
	file, _, err := Open(projects, path, want)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if got, _ := io.ReadAll(file); string(got) != "mine\n" {
		t.Fatalf("read %q", got)
	}
}

func TestOpenRefusesAFileReachedThroughAProjectFolderThatBecameALink(t *testing.T) {
	for _, link := range folderLinks() {
		t.Run(link.name, func(t *testing.T) {
			config := t.TempDir()
			projects := filepath.Join(config, "projects")
			outside := filepath.Join(t.TempDir(), "outside")
			write(t, filepath.Join(outside, session+".jsonl"), "secret\n")
			write(t, filepath.Join(projects, "inside", session+".jsonl"), "inside\n")
			for _, target := range []string{outside, filepath.Join(projects, "inside")} {
				folder := filepath.Join(projects, "p-"+filepath.Base(target))
				makeLink(t, link, target, folder)
				path := filepath.Join(folder, session+".jsonl")
				want, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				if file, _, err := Open(projects, path, want); err == nil {
					file.Close()
					t.Fatalf("opened a file through a linked folder to %s", target)
				}
			}
		})
	}
}

func TestOpenRefusesAHardLinkedFile(t *testing.T) {
	projects := filepath.Join(t.TempDir(), "projects")
	outside := filepath.Join(t.TempDir(), "secret")
	write(t, outside, "secret\n")
	path := filepath.Join(projects, "p", session+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, path); err != nil {
		t.Skipf("no hard links here: %v", err)
	}
	want, ok := RegularFile(path)
	if !ok {
		t.Fatal("a hard link is not a regular file")
	}
	if file, _, err := Open(projects, path, want); err == nil {
		file.Close()
		t.Fatal("opened a hard-linked file")
	}
}

func TestOpenRefusesAPathOutsideTheProjectsFolder(t *testing.T) {
	config := t.TempDir()
	projects := filepath.Join(config, "projects")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config, session+".jsonl")
	write(t, path, "outside\n")
	for _, p := range []string{path, projects, ""} {
		if file, _, err := Open(projects, p, nil); err == nil {
			file.Close()
			t.Fatalf("opened %s", p)
		}
	}
	if file, _, err := Open("", path, nil); err == nil {
		file.Close()
		t.Fatal("opened a file with no projects folder")
	}
}

func TestOpenFollowsALinkedProjectsFolder(t *testing.T) {
	shared := filepath.Join(t.TempDir(), "projects")
	write(t, filepath.Join(shared, "p", session+".jsonl"), "shared\n")
	for _, link := range folderLinks() {
		t.Run(link.name, func(t *testing.T) {
			projects := filepath.Join(t.TempDir(), "projects")
			makeLink(t, link, shared, projects)
			path := filepath.Join(projects, "p", session+".jsonl")
			want, ok := RegularFile(path)
			if !ok {
				t.Fatal("the session file under a linked projects folder is not found")
			}
			file, _, err := Open(projects, path, want)
			if err != nil {
				t.Fatal(err)
			}
			file.Close()
		})
	}
}

func TestRemoveDeletesNothingThroughAProjectFolderThatBecameALink(t *testing.T) {
	for _, link := range folderLinks() {
		t.Run(link.name, func(t *testing.T) {
			projects := filepath.Join(t.TempDir(), "projects")
			if err := os.MkdirAll(projects, 0o755); err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "outside")
			outsideFile := filepath.Join(outside, session+".jsonl")
			outsideFolder := filepath.Join(outside, session)
			write(t, outsideFile, "secret\n")
			write(t, filepath.Join(outsideFolder, "kept"), "kept\n")
			folder := filepath.Join(projects, "p")
			makeLink(t, link, outside, folder)
			if err := Remove(projects, filepath.Join(folder, session+".jsonl")); err == nil {
				t.Fatal("removed a file through a linked folder")
			}
			if err := RemoveAll(projects, filepath.Join(folder, session)); err == nil {
				t.Fatal("removed a folder through a linked folder")
			}
			for _, kept := range []string{outsideFile, filepath.Join(outsideFolder, "kept")} {
				if _, err := os.Stat(kept); err != nil {
					t.Fatalf("%s is gone: %v", kept, err)
				}
			}
		})
	}
}

func TestRemoveDeletesASessionUnderTheProjectsFolder(t *testing.T) {
	projects := filepath.Join(t.TempDir(), "projects")
	path := filepath.Join(projects, "p", session+".jsonl")
	write(t, path, "mine\n")
	write(t, filepath.Join(projects, "p", session, "subagents", "agent-a.jsonl"), "{}\n")
	if err := Remove(projects, path); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAll(projects, filepath.Join(projects, "p", session)); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{path, filepath.Join(projects, "p", session)} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s is still there: %v", gone, err)
		}
	}
}
