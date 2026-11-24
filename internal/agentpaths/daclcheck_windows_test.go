package agentpaths

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestDaclAllowsOnlyComparesSidsNotTheirSpelling(t *testing.T) {
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := windows.StringToSid("LA")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		sddl string
		user *windows.SID
		want bool
	}{
		{"D:P(A;OICI;FA;;;LA)", admin, true},
		{"D:P(A;OICI;FA;;;" + admin.String() + ")", admin, true},
		{"O:LAG:LAD:P(A;OICI;FA;;;LA)(A;OICIIO;GA;;;LA)", admin, true},
		{"D:P(A;OICI;FA;;;SY)", system, true},
		{"D:P(A;OICI;FA;;;S-1-5-18)", system, true},
		{"D:P(A;OICI;FA;;;LA)(A;;FR;;;WD)", admin, false},
		{"D:P(A;OICI;FA;;;LA)(D;;FA;;;WD)", admin, false},
		{"D:P(A;OICI;FA;;;SY)", admin, false},
		{"D:P", admin, false},
		{"D:NO_ACCESS_CONTROL", admin, false},
	} {
		if problem := daclProblem(c.sddl, c.user); (problem == "") != c.want {
			t.Errorf("daclProblem(%s, %s) = %q, want private=%v", c.sddl, c.user, problem, c.want)
		}
	}
}
