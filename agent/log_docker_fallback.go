package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var dockerEmbeddedTimestamp = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}) `)

func cloneDockerStreamCursors(existing map[string]dockerStreamCursor, since time.Time, seen int) map[string]dockerStreamCursor {
	streams := make(map[string]dockerStreamCursor, 2)
	for stream, cursor := range existing {
		streams[stream] = cursor
	}
	for _, stream := range []string{"stdout", "stderr"} {
		if _, ok := streams[stream]; !ok {
			streams[stream] = dockerStreamCursor{Since: since, Seen: seen, Boundary: true}
		}
	}
	return streams
}

func markDockerStreamBoundaries(streams map[string]dockerStreamCursor) {
	for stream, cursor := range streams {
		cursor.Boundary = true
		streams[stream] = cursor
	}
}

func advanceDockerStreamCursor(cursor *dockerStreamCursor, at time.Time) {
	if at.Equal(cursor.Since) {
		cursor.Seen++
	} else if at.After(cursor.Since) {
		cursor.Since, cursor.Seen = at, 1
	}
}

// Docker timestamps every fragment, including those inside a single line.
// The CLI does not distinguish an inserted timestamp from application text,
// so ambiguous lines are redacted rather than filtered or masked partially.
func readDockerFallback(ctx context.Context, id, name string, position *dockerLogCursor, initialTail, reset bool, tailLines, byteLimit, lineLimit int) ([]dockerLogLine, bool, uint64, uint64, error) {
	position.Streams = cloneDockerStreamCursors(position.Streams, position.Since, position.Seen)
	started := time.Now()
	args := []string{dockerBinary(), "logs", "--timestamps"}
	if initialTail {
		for stream, cursor := range position.Streams {
			cursor.Since, cursor.Seen, cursor.Boundary = time.Time{}, 0, true
			position.Streams[stream] = cursor
		}
		args = append(args, "--tail", strconv.Itoa(tailLines))
	} else {
		oldest := position.Streams["stdout"].Since
		if other := position.Streams["stderr"].Since; other.Before(oldest) {
			oldest = other
		}
		value := "0"
		if !oldest.IsZero() {
			value = oldest.Format(time.RFC3339Nano)
		}
		args = append(args, "--since", value)
	}
	args = append(args, id)
	baseline := cloneDockerStreamCursors(position.Streams, position.Since, position.Seen)
	skipped := map[string]int{}
	var lines []dockerLogLine
	var dropped, masked uint64
	read, count, retainedBytes := 0, 0, 0
	more := false
	var invalid bool
	err := streamDockerRecords(ctx, args, func(stream string, raw []byte, complete bool) bool {
		stamp, text, ok := strings.Cut(string(raw), " ")
		at, parseErr := time.Parse(time.RFC3339Nano, stamp)
		if !ok || parseErr != nil {
			invalid = true
			return false
		}
		base, cursor := baseline[stream], position.Streams[stream]
		if at.Before(base.Since) || at.Equal(base.Since) && skipped[stream] < base.Seen {
			if at.Equal(base.Since) {
				skipped[stream]++
				if complete && cursor.Discard && skipped[stream] == base.Seen {
					cursor.Discard = false
				}
			}
			if complete {
				cursor.Boundary = false
			}
			position.Streams[stream] = cursor
			return true
		}
		advanceDockerStreamCursor(&cursor, at)
		switch {
		case !complete:
			if !cursor.Discard {
				log.Printf("robin-agent: warning: discarded an incomplete docker logs line from %s", name)
				dropped++
			}
			cursor.Discard = true
		case cursor.Discard:
			cursor.Discard, cursor.Boundary = false, false
		default:
			redacted := false
			ambiguous := false
			for _, match := range dockerEmbeddedTimestamp.FindAllStringIndex(text, -1) {
				if match[0] > 0 {
					ambiguous = true
					break
				}
			}
			if cursor.Boundary || ambiguous {
				text = "[REDACTED] ambiguous Docker log line"
				masked++
				redacted = true
			}
			cursor.Boundary = false
			lines = append(lines, dockerLogLine{id: id, name: name, stream: stream, line: text, at: at, historical: reset, redacted: redacted})
			retainedBytes += len(text)
			if initialTail {
				for len(lines) > max(1, lineLimit) || retainedBytes > max(1, byteLimit) && len(lines) > 1 {
					oldest := 0
					for i := 1; i < len(lines); i++ {
						if lines[i].at.Before(lines[oldest].at) {
							oldest = i
						}
					}
					retainedBytes -= len(lines[oldest].line)
					if lines[oldest].redacted {
						masked--
					}
					lines = append(lines[:oldest], lines[oldest+1:]...)
				}
			}
		}
		position.Streams[stream] = cursor
		read, count = read+len(raw)+1, count+1
		if !initialTail && (read >= max(1, byteLimit) || count >= max(1, lineLimit)) {
			more = true
			return false
		}
		return true
	})
	if invalid {
		return nil, false, 0, 0, fmt.Errorf("docker logs %s returned an invalid timestamped record", name)
	}
	if err != nil {
		return nil, false, 0, 0, fmt.Errorf("docker logs %s: %w", name, err)
	}
	if masked > 0 {
		log.Printf("robin-agent: warning: redacted %d ambiguous docker logs line(s) from %s", masked, name)
	}
	if initialTail {
		started = position.Since
	}
	if initialTail || !more {
		for stream, cursor := range position.Streams {
			if !cursor.Discard && cursor.Since.Before(started) {
				cursor.Since, cursor.Seen = started, 0
			}
			position.Streams[stream] = cursor
		}
	}
	return lines, more, dropped, masked, nil
}

type dockerStreamRecord struct {
	stream   string
	line     []byte
	complete bool
	err      error
}

func streamDockerRecords(parent context.Context, argv []string, visit func(string, []byte, bool) bool) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stdout.Close()
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		_ = stdoutWriter.Close()
		return err
	}
	defer stderr.Close()
	process := exec.CommandContext(ctx, argv[0], argv[1:]...)
	process.WaitDelay = commandWaitDelay
	process.Stdout, process.Stderr = stdoutWriter, stderrWriter
	if err := process.Start(); err != nil {
		_ = stdoutWriter.Close()
		_ = stderrWriter.Close()
		return err
	}
	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()
	stopReading := context.AfterFunc(ctx, func() {
		_ = stdout.Close()
		_ = stderr.Close()
	})
	defer stopReading()
	records := make(chan dockerStreamRecord, 2)
	var readers sync.WaitGroup
	for stream, reader := range map[string]*os.File{"stdout": stdout, "stderr": stderr} {
		readers.Add(1)
		go func(stream string, reader *os.File) {
			defer readers.Done()
			buffered := bufio.NewReaderSize(reader, 64<<10)
			send := func(record dockerStreamRecord) bool {
				select {
				case records <- record:
					return true
				case <-ctx.Done():
					return false
				}
			}
			for {
				line, readErr := readBoundedLine(buffered, logRawEntryMaxBytes+1)
				if len(line) > logRawEntryMaxBytes {
					send(dockerStreamRecord{stream: stream, err: errors.New("Docker log line exceeds the bounded input limit")})
					return
				}
				if len(line) > 0 || readErr == nil {
					if !send(dockerStreamRecord{stream: stream, line: line, complete: readErr == nil}) {
						return
					}
				}
				if readErr != nil {
					if !errors.Is(readErr, io.EOF) {
						send(dockerStreamRecord{stream: stream, err: readErr})
					}
					return
				}
			}
		}(stream, reader)
	}
	done := make(chan struct{})
	go func() {
		readers.Wait()
		close(records)
		close(done)
	}()
	stopped := false
	var readErr error
	for record := range records {
		if record.err != nil {
			readErr = record.err
			cancel()
			break
		}
		if !visit(record.stream, record.line, record.complete) {
			stopped = true
			cancel()
			break
		}
	}
	if stopped || readErr != nil {
		<-done
	}
	waitErr := process.Wait()
	switch {
	case parent.Err() != nil:
		return parent.Err()
	case readErr != nil:
		return readErr
	case stopped:
		return nil
	default:
		return waitErr
	}
}
