package pty

import "strings"

const msysSpecialChars = "\"'*?[{"

func windowsCommandLine(program string, args []string) string {
	var b strings.Builder
	b.WriteString(windowsProgramName(program))
	for _, arg := range args {
		b.WriteByte(' ')
		b.WriteString(windowsArg(arg))
	}
	return b.String()
}

func windowsProgramName(program string) string {
	mustQuote := program == "" || program[0] == '"'
	for i := 0; i < len(program) && !mustQuote; i++ {
		mustQuote = program[i] <= ' '
	}
	if !mustQuote {
		return program
	}
	return `"` + strings.ReplaceAll(program, `"`, "") + `"`
}

func windowsArg(arg string) string {
	if arg == "" {
		return `""`
	}
	if !strings.ContainsAny(arg, " \t"+msysSpecialChars) {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for i := 0; i < len(arg); i++ {
		c := arg[i]
		switch c {
		case '\\':
			slashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes+1))
			slashes = 0
		default:
			slashes = 0
		}
		b.WriteByte(c)
	}
	b.WriteString(strings.Repeat(`\`, slashes))
	b.WriteByte('"')
	return b.String()
}
