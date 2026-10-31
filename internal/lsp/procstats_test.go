package lsp

import "testing"

func TestParseProcStatCountsFieldsFromTheLastParenthesis(t *testing.T) {
	// The command name holds a space and a ")", as a process may name itself.
	stat := "4242 (node) worker) S 4200 4242 4242 0 -1 4194304 1 0 0 0 3 1 0 0 20 0 11 0 100 1000000 250 18446744073709551615\n"

	entry, ok := parseProcStat([]byte(stat), 4096)
	if !ok {
		t.Fatal("parseProcStat() could not read the line")
	}
	if entry.ppid != 4200 || entry.rss != 250*4096 {
		t.Fatalf("parseProcStat() = %+v, want ppid 4200 and 250 pages", entry)
	}
}

func TestParsePSOutput(t *testing.T) {
	out := "    1     0  1024\n  500     1  2048\nnot a row\n"

	table := parsePSOutput([]byte(out))
	if len(table) != 2 || table[500] != (processEntry{ppid: 1, rss: 2048 * 1024}) {
		t.Fatalf("parsePSOutput() = %+v", table)
	}
}

func TestTreeRSSSumsEachServersDescendants(t *testing.T) {
	table := map[int]processEntry{
		1:  {ppid: 0, rss: 1},
		10: {ppid: 1, rss: 100}, // a server
		11: {ppid: 10, rss: 200},
		12: {ppid: 11, rss: 300},
		20: {ppid: 1, rss: 400}, // another
	}

	totals := treeRSS(table, []int{10, 20, 99})
	if totals[10] != 600 || totals[20] != 400 {
		t.Fatalf("treeRSS() = %v, want 600 and 400", totals)
	}
	if _, ok := totals[99]; ok {
		t.Fatal("treeRSS() reported a process that is not running")
	}
}
