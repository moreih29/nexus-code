package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"unicode/utf8"
)

type goComment struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
	Cgo   bool   `json:"cgo"`
}

type goFile struct {
	File      string      `json:"file"`
	Generated bool        `json:"generated"`
	Error     string      `json:"error,omitempty"`
	Comments  []goComment `json:"comments"`
}

func utf16Offsets(src []byte) []int {
	offsets := make([]int, len(src)+1)
	units := 0
	for i := 0; i < len(src); {
		r, size := utf8.DecodeRune(src[i:])
		for j := 0; j < size; j++ {
			offsets[i+j] = units
		}
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
		i += size
	}
	offsets[len(src)] = units
	return offsets
}

func scan(path string) goFile {
	result := goFile{File: path, Comments: []goComment{}}
	src, err := os.ReadFile(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Generated = ast.IsGenerated(file)
	cgoGroups := map[*ast.CommentGroup]bool{}
	for _, spec := range file.Imports {
		if spec.Path != nil && spec.Path.Value == `"C"` {
			if spec.Doc != nil {
				cgoGroups[spec.Doc] = true
			}
			for _, decl := range file.Decls {
				gen, ok := decl.(*ast.GenDecl)
				if ok && gen.Tok == token.IMPORT && gen.Doc != nil {
					for _, s := range gen.Specs {
						if s == spec {
							cgoGroups[gen.Doc] = true
						}
					}
				}
			}
		}
	}
	offsets := utf16Offsets(src)
	base := fset.File(file.Pos()).Base()
	for _, group := range file.Comments {
		for _, c := range group.List {
			start := int(c.Pos()) - base
			end := int(c.End()) - base
			result.Comments = append(result.Comments, goComment{
				Start: offsets[start],
				End:   offsets[end],
				Text:  c.Text,
				Cgo:   cgoGroups[group],
			})
		}
	}
	return result
}

func main() {
	files := []goFile{}
	for _, path := range os.Args[1:] {
		files = append(files, scan(path))
	}
	out, err := json.Marshal(files)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
}
