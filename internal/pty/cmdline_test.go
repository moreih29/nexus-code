package pty

import (
	"reflect"
	"strings"
	"testing"
)

func TestWindowsArgQuotesWhatMsysWouldSplitOrExpand(t *testing.T) {
	cases := []struct{ arg, want string }{
		{"", `""`},
		{"plain", "plain"},
		{`C:\tools\nu.exe`, `C:\tools\nu.exe`},
		{`\\server\share`, `\\server\share`},
		{`tail\`, `tail\`},
		{"~/x", "~/x"},
		{"%PATH%", "%PATH%"},
		{"$HOME", "$HOME"},
		{"x y", `"x y"`},
		{`C:\dir with space\`, `"C:\dir with space\\"`},
		{`a"b`, `"a\"b"`},
		{`"`, `"\""`},
		{`a\"b`, `"a\\\"b"`},
		{`a\\"b c`, `"a\\\\\"b c"`},
		{"it's", `"it's"`},
		{"*.txt", `"*.txt"`},
		{"m?.txt", `"m?.txt"`},
		{"[m]1.txt", `"[m]1.txt"`},
		{"{a,b}", `"{a,b}"`},
		{"한글 값", `"한글 값"`},
	}
	for _, c := range cases {
		if got := windowsArg(c.arg); got != c.want {
			t.Errorf("windowsArg(%q) = %s, want %s", c.arg, got, c.want)
		}
	}
}

func TestWindowsProgramNameQuotesAsCreateProcessReadsIt(t *testing.T) {
	cases := []struct{ program, want string }{
		{`C:\Windows\System32\cmd.exe`, `C:\Windows\System32\cmd.exe`},
		{`C:\Program Files\Git\bin\bash.exe`, `"C:\Program Files\Git\bin\bash.exe"`},
		{"", `""`},
		{`"C:\odd"`, `"C:\odd"`},
	}
	for _, c := range cases {
		if got := windowsProgramName(c.program); got != c.want {
			t.Errorf("windowsProgramName(%q) = %s, want %s", c.program, got, c.want)
		}
	}
}

func TestWindowsCommandLineReadsBackTheSameArgumentsUnderMsvcrtRules(t *testing.T) {
	args := []string{
		`a"b`, "x y", "", `C:\dir with space\`, "한글 값", "it's", "*.txt", `a\"b`,
		`\\server\share`, `tail\`, "{a,b}", "~/x", `q"`, `"`, `a\\"b c`, "plain", "$HOME", "%PATH%",
		`\`, `\\`, `"\`, "\t", `ends with quote"`,
	}
	program := `C:\Program Files\Git\usr\bin\printf.exe`
	line := windowsCommandLine(program, args)
	got := msvcrtArgv(line)
	if got[0] != program {
		t.Errorf("program read back as %q from %s", got[0], line)
	}
	if !reflect.DeepEqual(got[1:], args) {
		t.Errorf("command line %s read back as %q, want %q", line, got[1:], args)
	}
}

func msvcrtArgv(line string) []string {
	var argv []string
	i := 0
	if strings.HasPrefix(line, `"`) {
		end := strings.IndexByte(line[1:], '"') + 1
		argv = append(argv, line[1:end])
		i = end + 1
	} else {
		end := strings.IndexAny(line, " \t")
		if end < 0 {
			end = len(line)
		}
		argv = append(argv, line[:end])
		i = end
	}
	for {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		if i >= len(line) {
			return argv
		}
		var arg strings.Builder
		inQuote := false
		for i < len(line) && (inQuote || (line[i] != ' ' && line[i] != '\t')) {
			slashes := 0
			for i < len(line) && line[i] == '\\' {
				slashes++
				i++
			}
			if i < len(line) && line[i] == '"' {
				arg.WriteString(strings.Repeat(`\`, slashes/2))
				if slashes%2 == 1 {
					arg.WriteByte('"')
				} else {
					inQuote = !inQuote
				}
				i++
				continue
			}
			arg.WriteString(strings.Repeat(`\`, slashes))
			if i < len(line) && (inQuote || (line[i] != ' ' && line[i] != '\t')) {
				arg.WriteByte(line[i])
				i++
			}
		}
		argv = append(argv, arg.String())
	}
}
