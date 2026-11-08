package sysstat

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

const procStat = `cpu  4705 150 1120 16250 520 0 30 5 100 0
cpu0 2352 75 560 8125 260 0 15 2 50 0
intr 123
`

func TestParseProcStat(t *testing.T) {
	times, ok := parseProcStat([]byte(procStat))
	if !ok {
		t.Fatal("not parsed")
	}
	// user..steal, not guest: 4705+150+1120+16250+520+0+30+5
	if times.total != 22780 || times.idle != 16770 {
		t.Fatalf("got %+v", times)
	}
	if _, ok := parseProcStat([]byte("intr 1\n")); ok {
		t.Fatal("parsed a file with no cpu line")
	}
}

const meminfo = `MemTotal:        8029156 kB
MemFree:          512000 kB
MemAvailable:    5029156 kB
Buffers:          100000 kB
`

func TestParseMeminfo(t *testing.T) {
	used, total, ok := parseMeminfo([]byte(meminfo))
	if !ok || total != 8029156*1024 || used != 3000000*1024 {
		t.Fatalf("got used %d total %d ok %v", used, total, ok)
	}
	if _, _, ok := parseMeminfo([]byte("MemTotal: 1 kB\n")); ok {
		t.Fatal("parsed without MemAvailable")
	}
}

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    70691.
Pages active:                                 635175.
Pages wired down:                             302926.
Pages purgeable:                                6612.
"Translation faults":                    42756437943.
File-backed pages:                            423612.
Anonymous pages:                              842413.
Pages occupied by compressor:                 402821.
`

func TestParseVMStat(t *testing.T) {
	used, ok := parseVMStat([]byte(vmStat))
	want := uint64(842413-6612+302926+402821) * 16384
	if !ok || used != want {
		t.Fatalf("got %d ok %v, want %d", used, ok, want)
	}
	if _, ok := parseVMStat([]byte("Pages free: 1.\n")); ok {
		t.Fatal("parsed without a page size")
	}
}

func TestParsePSCPU(t *testing.T) {
	share, ok := parsePSCPU([]byte(" 12.5\n 0.0\n 87,5\n"), 4)
	if !ok || share != 25 {
		t.Fatalf("got %v ok %v", share, ok)
	}
	if share, _ := parsePSCPU([]byte("400\n100\n"), 4); share != 100 {
		t.Fatalf("not capped: %v", share)
	}
	if _, ok := parsePSCPU([]byte(""), 4); ok {
		t.Fatal("parsed no processes")
	}
}

func TestBusy(t *testing.T) {
	share, ok := busy(cpuTimes{total: 1000, idle: 800}, cpuTimes{total: 1200, idle: 950})
	if !ok || math.Abs(share-25) > 1e-9 {
		t.Fatalf("got %v ok %v", share, ok)
	}
	if _, ok := busy(cpuTimes{total: 1000}, cpuTimes{total: 1000}); ok {
		t.Fatal("no time passed, yet a share")
	}
}

// fakeService reads a host whose CPU readings come from a list.
func fakeService(readings []cpuTimes, clock *time.Time) (*Service, *int) {
	reads := 0
	slept := 0
	s := &Service{
		direct: noDirect,
		readCPU: func() (cpuTimes, error) {
			r := readings[reads]
			reads++
			return r, nil
		},
		readMemory: func() (uint64, uint64, error) { return 3, 8, nil },
		sleep: func(d time.Duration) {
			slept++
			*clock = clock.Add(d)
		},
		now: func() time.Time { return *clock },
	}
	return s, &slept
}

func noDirect() (*float64, bool) { return nil, false }

func TestServiceSpans(t *testing.T) {
	clock := time.Unix(1000, 0)
	s, slept := fakeService([]cpuTimes{
		{total: 1000, idle: 900},  // the first ask starts a span…
		{total: 1100, idle: 950},  // …and answers for it: 50%
		{total: 1300, idle: 1100}, // the next, from the last: 25%
		{total: 1300, idle: 1100}, // no time passed: the last answer
		{total: 5000, idle: 4000}, // after a long gap a new span starts…
		{total: 5100, idle: 4090}, // …10%
	}, &clock)
	ask := func() Stats {
		t.Helper()
		got, err := s.Stats(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		return got.(Stats)
	}
	if got := ask(); got.CPU == nil || *got.CPU != 50 || got.MemUsed != 3 || got.MemTotal != 8 {
		t.Fatalf("first: %+v", got)
	}
	clock = clock.Add(3 * time.Second)
	if got := ask(); *got.CPU != 25 {
		t.Fatalf("second: %v", *got.CPU)
	}
	if got := ask(); *got.CPU != 25 {
		t.Fatalf("again: %v", *got.CPU)
	}
	clock = clock.Add(time.Minute)
	if got := ask(); math.Abs(*got.CPU-10) > 1e-9 {
		t.Fatalf("after a gap: %v", *got.CPU)
	}
	if *slept != 2 {
		t.Fatalf("slept %d times, want 2", *slept)
	}
}

func TestServiceMemoryWithoutCPU(t *testing.T) {
	s := &Service{
		direct:     noDirect,
		readCPU:    func() (cpuTimes, error) { return cpuTimes{}, errors.New("no") },
		readMemory: func() (uint64, uint64, error) { return 1, 2, nil },
		sleep:      func(time.Duration) {},
		now:        time.Now,
	}
	got, err := s.Stats(context.Background(), nil)
	if err != nil || got.(Stats).MemTotal != 2 {
		t.Fatalf("got %+v %v", got, err)
	}
	s.readMemory = func() (uint64, uint64, error) { return 0, 0, errors.New("no") }
	if _, err := s.Stats(context.Background(), nil); err == nil {
		t.Fatal("neither read, yet no error")
	}
}

func TestServiceDirectShare(t *testing.T) {
	share := 42.0
	s := &Service{
		direct:     func() (*float64, bool) { return &share, true },
		readCPU:    func() (cpuTimes, error) { t.Fatal("read the totals"); return cpuTimes{}, nil },
		readMemory: func() (uint64, uint64, error) { return 1, 2, nil },
		sleep:      func(time.Duration) { t.Fatal("slept") },
		now:        time.Now,
	}
	got, err := s.Stats(context.Background(), nil)
	if err != nil || *got.(Stats).CPU != 42 {
		t.Fatalf("got %+v %v", got, err)
	}
}

func TestHostReads(t *testing.T) {
	got, err := New().Stats(context.Background(), nil)
	if err != nil {
		t.Skipf("not read here: %v", err)
	}
	stats := got.(Stats)
	if stats.MemTotal == 0 || stats.MemUsed > stats.MemTotal {
		t.Fatalf("memory: %+v", stats)
	}
	if stats.CPU != nil && (*stats.CPU < 0 || *stats.CPU > 100) {
		t.Fatalf("cpu: %v", *stats.CPU)
	}
	cpu := "unknown"
	if stats.CPU != nil {
		cpu = fmt.Sprintf("%.1f%%", *stats.CPU)
	}
	t.Logf("cpu %s used %d total %d", cpu, stats.MemUsed, stats.MemTotal)
}
