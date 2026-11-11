package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type dockerLogLine struct {
	id         string
	name       string
	stream     string
	line       string
	at         time.Time
	historical bool
	redacted   bool
}

type dockerInspectInfo struct {
	ID      string
	Name    string
	LogPath string
	Driver  string
	Created time.Time
	Options map[string]string
}

// Reuse a Docker discovery snapshot only within a bounded collection window.
type dockerDiscovery struct {
	selector   string
	label      string
	containers [][2]string
	info       map[string]dockerInspectInfo
	ready      bool
}

type dockerJSONLogLine struct {
	Log    string `json:"log"`
	Time   string `json:"time"`
	Stream string `json:"stream"`
}

func dockerBinary() string {
	if dir := os.Getenv("ROBIN_TEST_DOCKER_DIR"); dir != "" {
		return filepath.Join(dir, "docker")
	}
	return "docker"
}

func listDockerContainers(ctx context.Context, selectors []string, label string) ([][2]string, error) {
	args := []string{"ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"}
	if label != "" {
		args = append(args, "--filter", "label="+label)
	}
	output, err := captureProcess(ctx, append([]string{dockerBinary()}, args...), false)
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	var containers [][2]string
	for _, row := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		id, name, ok := strings.Cut(strings.TrimSpace(row), "\t")
		if !ok || id == "" || name == "" || !matchesContainerSelector(name, selectors) {
			continue
		}
		containers = append(containers, [2]string{id, strings.TrimPrefix(name, "/")})
	}
	sort.Slice(containers, func(i, j int) bool { return containers[i][1] < containers[j][1] })
	return containers, nil
}

func matchesContainerSelector(name string, selectors []string) bool {
	if len(selectors) == 0 {
		return true
	}
	for _, selector := range selectors {
		matched, err := filepath.Match(selector, name)
		if err == nil && matched {
			return true
		}
		if err == nil && !strings.ContainsAny(selector, "*?[") && selector == name {
			return true
		}
	}
	return false
}

func inspectDockerContainer(ctx context.Context, id string) (dockerInspectInfo, error) {
	output, err := captureProcess(ctx, []string{
		dockerBinary(), "inspect", "--format",
		"{{.Id}}\t{{.Name}}\t{{.LogPath}}\t{{.HostConfig.LogConfig.Type}}\t{{.Created}}\t{{json .HostConfig.LogConfig.Config}}", id,
	}, false)
	if err != nil {
		return dockerInspectInfo{}, fmt.Errorf("docker inspect %s: %w", id, err)
	}
	fields := strings.SplitN(strings.TrimSpace(string(output)), "\t", 6)
	if len(fields) != 6 {
		return dockerInspectInfo{}, fmt.Errorf("docker inspect %s returned incomplete metadata", id)
	}
	created, err := time.Parse(time.RFC3339Nano, fields[4])
	if err != nil {
		return dockerInspectInfo{}, fmt.Errorf("parse Docker creation time for %s: %w", id, err)
	}
	var options map[string]string
	if err := json.Unmarshal([]byte(fields[5]), &options); err != nil {
		return dockerInspectInfo{}, fmt.Errorf("parse Docker log options for %s: %w", id, err)
	}
	return dockerInspectInfo{
		ID: fields[0], Name: strings.TrimPrefix(fields[1], "/"),
		LogPath: fields[2], Driver: fields[3], Created: created, Options: options,
	}, nil
}

func (discovery *dockerDiscovery) list(ctx context.Context, selector string, selectors []string, label string) ([][2]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if discovery != nil && discovery.ready && discovery.selector == selector && discovery.label == label {
		return discovery.containers, nil
	}
	containers, err := listDockerContainers(ctx, selectors, label)
	if err != nil {
		return nil, err
	}
	if discovery != nil {
		*discovery = dockerDiscovery{
			selector: selector, label: label, containers: containers,
			info: make(map[string]dockerInspectInfo, len(containers)), ready: true,
		}
	}
	return containers, nil
}

func (discovery *dockerDiscovery) inspect(ctx context.Context, id string) (dockerInspectInfo, error) {
	if err := ctx.Err(); err != nil {
		return dockerInspectInfo{}, err
	}
	if discovery != nil {
		if info, ok := discovery.info[id]; ok {
			return info, nil
		}
	}
	info, err := inspectDockerContainer(ctx, id)
	if err == nil && discovery != nil {
		discovery.info[id] = info
	}
	return info, err
}

func completeDockerJSONHistory(info dockerInspectInfo, paths []string) bool {
	if len(paths) == 0 || paths[len(paths)-1] != info.LogPath {
		return false
	}
	maxSize := info.Options["max-size"]
	if maxSize == "" || maxSize == "-1" {
		return len(paths) == 1
	}
	maxFiles, err := strconv.Atoi(info.Options["max-file"])
	if err != nil || maxFiles < 2 || len(paths) >= maxFiles ||
		!strings.EqualFold(info.Options["compress"], "false") && info.Options["compress"] != "" {
		return false
	}
	for i, number := len(paths)-2, 1; i >= 0; i, number = i-1, number+1 {
		if paths[i] != info.LogPath+"."+strconv.Itoa(number) {
			return false
		}
	}
	return true
}

func parseContainerSelectors(value string) []string {
	value = strings.ReplaceAll(value, ",", ";")
	return splitLogConfigList(value)
}

func followContainerSet(ctx context.Context, key, selectorText, label string, cur *logCursor) (*logBatch, bool, error) {
	return followContainerSetWithTail(ctx, key, selectorText, label, cur, logTailLines, logTailMaxBytes, nil)
}

func followContainerSetWithTail(ctx context.Context, key, selectorText, label string, cur *logCursor, tailLines, tailBytes int, discovery *dockerDiscovery) (*logBatch, bool, error) {
	selectors := parseContainerSelectors(selectorText)
	for _, selector := range selectors {
		if _, err := filepath.Match(selector, "validation"); err != nil {
			return nil, false, fmt.Errorf("invalid Docker container pattern %q: %w", selector, err)
		}
	}
	containers, err := discovery.list(ctx, selectorText, selectors, label)
	if err != nil {
		return nil, false, err
	}
	started := time.Now()
	reset := cur == nil
	next := logCursor{Key: key, Source: "docker containers", Containers: make(map[string]dockerLogCursor, len(containers))}
	if cur != nil {
		next = *cur
		next.Key = key
		next.Source = "docker containers"
		next.Containers = make(map[string]dockerLogCursor, len(cur.Containers)+len(containers))
		for id, cursor := range cur.Containers {
			next.Containers[id] = cursor
		}
	}
	legacyName := ""
	if cur != nil && strings.HasPrefix(cur.Source, "docker logs ") {
		legacyName = strings.TrimPrefix(cur.Source, "docker logs ")
	}
	legacyCursor := cur != nil && len(cur.Containers) == 0 &&
		len(containers) == 1 && containers[0][1] == legacyName
	lines := make([]dockerLogLine, 0)
	present := make(map[string]bool, len(containers))
	for _, container := range containers {
		present[container[0]] = true
	}
	more := false
	pendingStreams := make(map[string]bool)
	var inputDropped uint64
	streams := len(containers)
	for id := range next.Containers {
		if !present[id] {
			streams++
		}
	}
	byteLimit, lineLimit := logBatchMaxBytes, logBatchMaxLines
	if reset {
		byteLimit, lineLimit = tailBytes, max(logBatchMaxLines, tailLines)
	}
	if streams > lineLimit {
		return nil, false, fmt.Errorf("Docker source has %d active or draining streams; at most %d can be read safely in one window", streams, lineLimit)
	}
	budget := max(1, byteLimit/max(1, streams))
	lineBudget := max(1, lineLimit/max(1, streams))
	for _, container := range containers {
		id, name := container[0], container[1]
		position, exists := next.Containers[id]
		initialTail := false
		info, inspectErr := discovery.inspect(ctx, id)
		if inspectErr != nil {
			return nil, false, inspectErr
		}
		if info.Name != "" {
			name = info.Name
		}
		if !exists {
			switch {
			case reset:
				position = dockerLogCursor{Name: name, Since: started, DockerCursor: 1}
				initialTail = true
			case legacyCursor:
				position = dockerLogCursor{
					Name: name, Since: cur.Since, Seen: cur.DockerSeen,
					DockerCursor: cur.DockerCursor,
				}
			default:
				position = dockerLogCursor{Name: name, Since: info.Created, DockerCursor: 1}
			}
		}
		position.Name, position.Driver, position.LogPath = name, info.Driver, info.LogPath
		if exists && len(position.Streams) == 0 && !position.Since.IsZero() {
			log.Printf("robin-agent: warning: upgrading Docker cursor for %s without per-stream positions; equal-timestamp lines may be skipped", name)
		}
		position.Streams = cloneDockerStreamCursors(position.Streams, position.Since, position.Seen)
		var batchLines []dockerLogLine
		var batchMore bool
		directJSON := false
		if info.Driver == "json-file" && info.LogPath != "" {
			if fileInfo, statErr := os.Stat(info.LogPath); statErr == nil && fileInfo.Mode().IsRegular() {
				directJSON = true
			}
		}
		if directJSON {
			var paths []string
			if position.File == nil {
				paths, err = numberedLogFiles(info.LogPath)
				if err != nil {
					return nil, false, fmt.Errorf("list Docker log files for %s: %w", name, err)
				}
				if len(paths) == 0 {
					return nil, false, fmt.Errorf("no readable Docker log file for %s", name)
				}
				if !initialTail && !exists && !reset && !legacyCursor && completeDockerJSONHistory(info, paths) {
					for stream, cursor := range position.Streams {
						cursor.Boundary = false
						position.Streams[stream] = cursor
					}
				}
			}
			if position.FragmentVersion == 0 {
				position.Partials = unknownDockerStreamBoundaries(position.Partials, position.Streams)
				position.FragmentVersion = 1
			}
			fileCursor := position.File
			if fileCursor == nil && !initialTail {
				fileCursor = &logCursor{
					Key: "docker-json-file:" + id, Source: paths[0], Path: paths[0],
				}
				position.ResumeSince, position.ResumeSeen = position.Since, position.Seen
				position.ResumeSkipped, position.ResumeActive = 0, !position.Since.IsZero()
				position.ResumeLegacy = position.DockerCursor == 0
				for stream, cursor := range position.Streams {
					cursor.ResumeSince, cursor.ResumeSeen, cursor.ResumeSkipped = cursor.Since, cursor.Seen, 0
					position.Streams[stream] = cursor
				}
			}
			fileBatch, fileMore, err := followFileWithTail(
				"docker-json-file:"+id, info.LogPath, "", fileCursor, budget, lineBudget, tailLines, budget,
			)
			if err == nil {
				position.File = &fileBatch.Next
				batchMore = fileMore
				inputDropped += fileBatch.InputDropped
				if initialTail && len(paths) == 1 && completeDockerJSONHistory(info, paths) {
					tailStart := fileBatch.Next.Offset
					for _, line := range fileBatch.Lines {
						tailStart -= int64(len(line) + 1)
					}
					if tailStart == 0 {
						for stream, cursor := range position.Streams {
							cursor.Boundary = false
							position.Streams[stream] = cursor
							if partial, ok := position.Partials[stream]; ok && partial.Boundary && partial.Time.IsZero() {
								delete(position.Partials, stream)
							}
						}
					}
				}
				if fileBatch.Discontinuity || fileBatch.InputDropped > 0 {
					inputDropped += unreportedDockerPartials(position.Partials)
					position.Partials = unknownDockerBoundaries(nil)
					markDockerStreamBoundaries(position.Streams)
				}
				decoded, dropped, decodeErr := decodeDockerJSONLines(id, name, fileBatch.Lines, &position, reset)
				if decodeErr != nil {
					return nil, false, decodeErr
				}
				inputDropped += dropped
				if !fileMore && !hasResumeDockerPartial(position) {
					position.ResumeActive = false
				}
				batchLines = append(batchLines, decoded...)
			} else if os.IsNotExist(err) || os.IsPermission(err) {
				directJSON = false
			} else {
				return nil, false, err
			}
		}
		if !directJSON && activeDockerPartials(position.Partials) > 0 {
			return nil, false, fmt.Errorf("cannot safely switch Docker container %s to docker logs while a json-file fragment is incomplete", name)
		}
		if !directJSON {
			var dropped uint64
			batchLines, batchMore, dropped, _, err = readDockerFallback(
				ctx, id, name, &position, initialTail, reset, tailLines, budget, lineBudget,
			)
			inputDropped += dropped
		}
		if err != nil {
			return nil, false, err
		}
		if !directJSON {
			position.File = nil
		}
		more = more || batchMore
		if batchMore || activeDockerPartials(position.Partials) > 0 {
			pendingStreams[id] = true
		}
		lines = append(lines, batchLines...)
		next.Containers[id] = position
	}
	for id, position := range next.Containers {
		if present[id] {
			continue
		}
		drained, updated, hasMore, dropped, _, drainErr := drainGoneDockerContainer(ctx, id, position, budget, lineBudget)
		inputDropped += dropped
		if drainErr != nil {
			log.Printf("robin-agent: warning: could not drain removed Docker container %s: %v", position.Name, drainErr)
			delete(next.Containers, id)
			continue
		}
		more = more || hasMore
		if hasMore || activeDockerPartials(updated.Partials) > 0 {
			pendingStreams[id] = true
		}
		if len(drained) == 0 && !hasMore {
			if unfinished := activeDockerPartials(updated.Partials); unfinished > 0 {
				log.Printf("robin-agent: warning: discarded %d incomplete Docker log line(s) from removed container %s", unfinished, position.Name)
				inputDropped += unreportedDockerPartials(updated.Partials)
			}
			delete(pendingStreams, id)
			delete(next.Containers, id)
			continue
		}
		updated.Gone = true
		next.Containers[id] = updated
		lines = append(lines, drained...)
	}
	sort.SliceStable(lines, func(i, j int) bool {
		if lines[i].at.Equal(lines[j].at) {
			if lines[i].name == lines[j].name {
				return false
			}
			return lines[i].name < lines[j].name
		}
		return lines[i].at.Before(lines[j].at)
	})
	capLines := logBatchMaxLines
	if reset {
		capLines = tailLines
		if len(lines) > capLines {
			lines = lines[len(lines)-capLines:]
		}
	}
	if len(lines) > capLines {
		lines, more = lines[:capLines], true
	}
	out, times, streamIDs := make([]string, 0, len(lines)), make([]string, 0, len(lines)), make([]string, 0, len(lines))
	historical := make([]bool, 0, len(lines))
	var inputMasked uint64
	for _, item := range lines {
		cursor := next.Containers[item.id]
		if item.at.Equal(cursor.Since) {
			cursor.Seen++
		} else if item.at.After(cursor.Since) {
			cursor.Since, cursor.Seen = item.at, 1
		}
		cursor.DockerCursor = 1
		next.Containers[item.id] = cursor
		out = append(out, "["+item.name+"] "+item.line)
		times = append(times, item.at.Format(time.RFC3339Nano))
		streamIDs = append(streamIDs, item.id)
		historical = append(historical, item.historical)
		if item.redacted {
			inputMasked++
		}
	}
	return &logBatch{
		Source:         "docker containers",
		Lines:          out,
		Times:          times,
		Streams:        streamIDs,
		Historical:     historical,
		PendingStreams: pendingStreams,
		Reset:          reset,
		Next:           next,
		InputDropped:   inputDropped,
		InputMasked:    inputMasked,
	}, more, nil
}

func drainGoneDockerContainer(ctx context.Context, id string, position dockerLogCursor, budget, lineBudget int) ([]dockerLogLine, dockerLogCursor, bool, uint64, uint64, error) {
	position.Streams = cloneDockerStreamCursors(position.Streams, position.Since, position.Seen)
	if position.Driver == "json-file" && position.LogPath != "" && position.File != nil {
		if fileInfo, err := os.Stat(position.LogPath); err == nil && fileInfo.Mode().IsRegular() {
			if position.FragmentVersion == 0 {
				position.Partials = unknownDockerStreamBoundaries(position.Partials, position.Streams)
				position.FragmentVersion = 1
			}
			batch, more, err := followFileWithLimits("docker-json-file:"+id, position.LogPath, "", position.File, budget, lineBudget)
			if err != nil {
				return nil, position, false, 0, 0, err
			}
			updated := position
			updated.File = &batch.Next
			dropped := batch.InputDropped
			if batch.Discontinuity || batch.InputDropped > 0 {
				dropped += unreportedDockerPartials(updated.Partials)
				updated.Partials = unknownDockerBoundaries(nil)
				markDockerStreamBoundaries(updated.Streams)
			}
			lines, partialDropped, err := decodeDockerJSONLines(id, position.Name, batch.Lines, &updated, false)
			return lines, updated, more, dropped + partialDropped, 0, err
		}
	}
	if activeDockerPartials(position.Partials) > 0 {
		return nil, position, false, unreportedDockerPartials(position.Partials), 0, errors.New("incomplete json-file fragment cannot be safely drained via docker logs")
	}
	lines, more, dropped, masked, err := readDockerFallback(
		ctx, id, position.Name, &position, false, false, 0, budget, lineBudget,
	)
	if err != nil {
		return nil, position, false, dropped, masked, err
	}
	position.File = nil
	return lines, position, more, dropped, masked, nil
}

func unknownDockerBoundaries(partials map[string]dockerLogPartial) map[string]dockerLogPartial {
	return unknownDockerStreamBoundaries(partials, map[string]dockerStreamCursor{
		"stdout": {Boundary: true},
		"stderr": {Boundary: true},
	})
}

func unknownDockerStreamBoundaries(partials map[string]dockerLogPartial, streams map[string]dockerStreamCursor) map[string]dockerLogPartial {
	cloned := make(map[string]dockerLogPartial, len(partials)+2)
	for stream, partial := range partials {
		cloned[stream] = partial
	}
	for _, stream := range []string{"stdout", "stderr"} {
		if _, ok := cloned[stream]; !ok && streams[stream].Boundary {
			cloned[stream] = dockerLogPartial{Discarding: true, Boundary: true}
		}
	}
	return cloned
}

func activeDockerPartials(partials map[string]dockerLogPartial) uint64 {
	var count uint64
	for _, partial := range partials {
		if !partial.Time.IsZero() {
			count++
		}
	}
	return count
}

func unreportedDockerPartials(partials map[string]dockerLogPartial) uint64 {
	var count uint64
	for _, partial := range partials {
		if !partial.Time.IsZero() && (!partial.Discarding || partial.Boundary) {
			count++
		}
	}
	return count
}

func hasResumeDockerPartial(position dockerLogCursor) bool {
	if !position.ResumeActive {
		return false
	}
	for stream, partial := range position.Partials {
		if !partial.Time.IsZero() && !partial.Time.After(position.Streams[stream].ResumeSince) {
			return true
		}
	}
	return false
}

func decodeDockerJSONLines(id, name string, rawLines []string, position *dockerLogCursor, reset bool) ([]dockerLogLine, uint64, error) {
	lines := make([]dockerLogLine, 0, len(rawLines))
	position.Streams = cloneDockerStreamCursors(position.Streams, position.Since, position.Seen)
	partials := make(map[string]dockerLogPartial, len(position.Partials))
	for stream, partial := range position.Partials {
		partials[stream] = partial
	}
	position.Partials = partials
	var dropped uint64
	for _, raw := range rawLines {
		var record dockerJSONLogLine
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			return nil, dropped, fmt.Errorf("invalid Docker json-file record for %s", id)
		}
		at, err := time.Parse(time.RFC3339Nano, record.Time)
		if err != nil {
			return nil, dropped, fmt.Errorf("invalid Docker json-file timestamp for %s", id)
		}
		stream := record.Stream
		if stream == "" {
			stream = "stdout"
		}
		if stream != "stdout" && stream != "stderr" {
			return nil, dropped, fmt.Errorf("invalid Docker json-file stream for %s", id)
		}
		if end := strings.IndexByte(record.Log, '\n'); end >= 0 && end != len(record.Log)-1 {
			return nil, dropped, fmt.Errorf("invalid Docker json-file line boundary for %s", id)
		}
		for text := record.Log; text != ""; {
			end := strings.IndexByte(text, '\n')
			part := text
			if end >= 0 {
				part, text = text[:end], text[end+1:]
			} else {
				text = ""
			}
			partial, exists := partials[stream]
			if !exists || partial.Time.IsZero() {
				partial.Time, partial.Historical = at, reset
			}
			if !partial.Discarding {
				if len(partial.Text)+len(part) > logRawEntryMaxBytes {
					log.Printf("robin-agent: warning: discarded an oversized Docker log line from %s", name)
					partial.Text, partial.Discarding = "", true
					dropped++
				} else {
					partial.Text += part
				}
			}
			if end < 0 {
				partials[stream] = partial
				continue
			}
			delete(partials, stream)
			cursor := position.Streams[stream]
			skip := false
			if position.ResumeActive {
				if partial.Time.Before(cursor.ResumeSince) {
					skip = true
				} else if partial.Time.Equal(cursor.ResumeSince) &&
					(position.ResumeLegacy || cursor.ResumeSkipped < cursor.ResumeSeen) {
					cursor.ResumeSkipped++
					skip = true
				}
			}
			if partial.Boundary {
				cursor.Boundary = false
				if !skip {
					log.Printf("robin-agent: warning: discarded a Docker log line with an unknown beginning from %s", name)
					dropped++
				}
			}
			discard := false
			if cursor.Discard {
				if skip && partial.Time.Equal(cursor.ResumeSince) && cursor.ResumeSkipped >= cursor.ResumeSeen {
					cursor.Discard = false
				} else if !skip {
					cursor.Discard, discard = false, true
				}
			}
			if !skip {
				advanceDockerStreamCursor(&cursor, partial.Time)
			}
			cursor.Boundary = false
			position.Streams[stream] = cursor
			if skip || discard || partial.Discarding {
				continue
			}
			lines = append(lines, dockerLogLine{
				id: id, name: name, stream: stream, line: strings.TrimSuffix(partial.Text, "\r"),
				at: partial.Time, historical: partial.Historical,
			})
		}
	}
	return lines, dropped, nil
}
