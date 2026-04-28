package search

import (
	"encoding/json"
	"strings"

	"nexus-code/sidecar/internal/contracts"
)

type ripgrepMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type ripgrepMatchData struct {
	Path struct {
		Text string `json:"text"`
	} `json:"path"`
	Lines struct {
		Text string `json:"text"`
	} `json:"lines"`
	LineNumber int `json:"line_number"`
	Submatches []struct {
		Match struct {
			Text string `json:"text"`
		} `json:"match"`
		Start int `json:"start"`
		End   int `json:"end"`
	} `json:"submatches"`
}

func ParseRipgrepJSONLine(line []byte) (*contracts.SearchResult, error) {
	line = []byte(strings.TrimSpace(string(line)))
	if len(line) == 0 {
		return nil, nil
	}

	var message ripgrepMessage
	if err := json.Unmarshal(line, &message); err != nil {
		return nil, err
	}
	if message.Type != "match" {
		return nil, nil
	}

	var data ripgrepMatchData
	if err := json.Unmarshal(message.Data, &data); err != nil {
		return nil, err
	}

	submatches := make([]contracts.SearchSubmatch, 0, len(data.Submatches))
	column := 1
	for index, submatch := range data.Submatches {
		if index == 0 {
			column = submatch.Start + 1
		}
		submatches = append(submatches, contracts.SearchSubmatch{
			Start: submatch.Start,
			End:   submatch.End,
			Match: submatch.Match.Text,
		})
	}

	return &contracts.SearchResult{
		Path:       normalizeRipgrepPath(data.Path.Text),
		LineNumber: data.LineNumber,
		Column:     column,
		LineText:   strings.TrimSuffix(data.Lines.Text, "\n"),
		Submatches: submatches,
	}, nil
}

func normalizeRipgrepPath(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "./")
	return path
}
