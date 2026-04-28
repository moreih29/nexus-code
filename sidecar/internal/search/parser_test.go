package search

import "testing"

func TestParseRipgrepJSONLineMapsMatchToSearchResult(t *testing.T) {
	line := []byte(`{"type":"match","data":{"path":{"text":"./src/main.go"},"lines":{"text":"foo bar foo\n"},"line_number":12,"absolute_offset":44,"submatches":[{"match":{"text":"foo"},"start":0,"end":3},{"match":{"text":"foo"},"start":8,"end":11}]}}`)

	result, err := ParseRipgrepJSONLine(line)
	if err != nil {
		t.Fatalf("ParseRipgrepJSONLine() error = %v", err)
	}
	if result == nil {
		t.Fatal("result = nil, want SearchResult")
	}
	if result.Path != "src/main.go" || result.LineNumber != 12 || result.Column != 1 || result.LineText != "foo bar foo" {
		t.Fatalf("result = %+v", result)
	}
	if len(result.Submatches) != 2 {
		t.Fatalf("submatches len = %d, want 2", len(result.Submatches))
	}
	if result.Submatches[1].Start != 8 || result.Submatches[1].End != 11 || result.Submatches[1].Match != "foo" {
		t.Fatalf("submatch[1] = %+v", result.Submatches[1])
	}
}

func TestParseRipgrepJSONLineIgnoresNonMatchMessages(t *testing.T) {
	result, err := ParseRipgrepJSONLine([]byte(`{"type":"begin","data":{"path":{"text":"src/main.go"}}}`))
	if err != nil {
		t.Fatalf("ParseRipgrepJSONLine() error = %v", err)
	}
	if result != nil {
		t.Fatalf("result = %+v, want nil", result)
	}
}
