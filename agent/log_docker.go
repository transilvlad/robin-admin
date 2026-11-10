package main

import (
	"context"
	"encoding/json"
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
	id   string
	name string
	line string
	at   time.Time
}

type dockerInspectInfo struct {
	ID      string
	Name    string
	LogPath string
	Driver  string
	Created time.Time
}

type dockerJSONLogLine struct {
	Log  string `json:"log"`
	Time string `json:"time"`
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
		"{{.Id}}\t{{.Name}}\t{{.LogPath}}\t{{.HostConfig.LogConfig.Type}}\t{{.Created}}", id,
	}, false)
	if err != nil {
		return dockerInspectInfo{}, fmt.Errorf("docker inspect %s: %w", id, err)
	}
	fields := strings.SplitN(strings.TrimSpace(string(output)), "\t", 5)
	if len(fields) != 5 {
		return dockerInspectInfo{}, fmt.Errorf("docker inspect %s returned incomplete metadata", id)
	}
	created, err := time.Parse(time.RFC3339Nano, fields[4])
	if err != nil {
		return dockerInspectInfo{}, fmt.Errorf("parse Docker creation time for %s: %w", id, err)
	}
	return dockerInspectInfo{
		ID: fields[0], Name: strings.TrimPrefix(fields[1], "/"),
		LogPath: fields[2], Driver: fields[3], Created: created,
	}, nil
}

func parseContainerSelectors(value string) []string {
	value = strings.ReplaceAll(value, ",", ";")
	return splitLogConfigList(value)
}

func followContainerSet(ctx context.Context, key, selectorText, label string, cur *logCursor) (*logBatch, bool, error) {
	return followContainerSetWithTail(ctx, key, selectorText, label, cur, logTailLines, logTailMaxBytes)
}

func followContainerSetWithTail(ctx context.Context, key, selectorText, label string, cur *logCursor, tailLines, tailBytes int) (*logBatch, bool, error) {
	selectors := parseContainerSelectors(selectorText)
	for _, selector := range selectors {
		if _, err := filepath.Match(selector, "validation"); err != nil {
			return nil, false, fmt.Errorf("invalid Docker container pattern %q: %w", selector, err)
		}
	}
	containers, err := listDockerContainers(ctx, selectors, label)
	if err != nil {
		return nil, false, err
	}
	if len(containers) == 0 && cur == nil {
		return nil, false, nil
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
		info, inspectErr := inspectDockerContainer(ctx, id)
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
		var batchLines []string
		var batchTimes []time.Time
		var batchMore bool
		directJSON := false
		if info.Driver == "json-file" && info.LogPath != "" {
			if fileInfo, statErr := os.Stat(info.LogPath); statErr == nil && fileInfo.Mode().IsRegular() {
				directJSON = true
			}
		}
		if directJSON {
			fileCursor := position.File
			if fileCursor == nil && !initialTail {
				fileCursor = &logCursor{
					Key: "docker-json-file:" + id, Source: info.LogPath, Path: info.LogPath,
				}
				position.ResumeSince, position.ResumeSeen = position.Since, position.Seen
				position.ResumeSkipped, position.ResumeActive = 0, !position.Since.IsZero()
				position.ResumeLegacy = position.DockerCursor == 0
			}
			fileBatch, fileMore, err := followFileWithTail(
				"docker-json-file:"+id, info.LogPath, "", fileCursor, budget, lineBudget, tailLines, budget,
			)
			if err == nil {
				position.File = &fileBatch.Next
				batchMore = fileMore
				inputDropped += fileBatch.InputDropped
				decoded, decodeErr := decodeDockerJSONLines(id, name, fileBatch.Lines, &position)
				if decodeErr != nil {
					return nil, false, decodeErr
				}
				for _, item := range decoded {
					batchLines = append(batchLines, item.line)
					batchTimes = append(batchTimes, item.at)
				}
			} else if os.IsNotExist(err) || os.IsPermission(err) {
				directJSON = false
			} else {
				return nil, false, err
			}
		}
		if !directJSON && initialTail {
			batchLines, batchTimes, _, batchMore, err = containerRead(
				ctx, id, time.Time{}, 0, false, true,
				"--tail", strconv.Itoa(tailLines), "robin-agent-budget="+strconv.Itoa(budget), "robin-agent-lines="+strconv.Itoa(lineBudget), "robin-agent-recent",
			)
		} else if !directJSON {
			batchLines, batchTimes, _, batchMore, err = containerRead(
				ctx, id, position.Since, position.Seen, position.DockerCursor == 0, true,
				"--since", position.Since.Format(time.RFC3339Nano), "robin-agent-budget="+strconv.Itoa(budget), "robin-agent-lines="+strconv.Itoa(lineBudget),
			)
		}
		if err != nil {
			return nil, false, err
		}
		if !directJSON {
			position.File = nil
		}
		more = more || batchMore
		for i, line := range batchLines {
			if i >= len(batchTimes) {
				break
			}
			lines = append(lines, dockerLogLine{id: id, name: name, line: line, at: batchTimes[i]})
		}
		next.Containers[id] = position
	}
	for id, position := range next.Containers {
		if present[id] {
			continue
		}
		drained, updated, hasMore, dropped, drainErr := drainGoneDockerContainer(ctx, id, position, budget, lineBudget)
		if drainErr != nil {
			log.Printf("robin-agent: warning: could not drain removed Docker container %s: %v", position.Name, drainErr)
			delete(next.Containers, id)
			continue
		}
		more = more || hasMore
		inputDropped += dropped
		if len(drained) == 0 && !hasMore {
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
	}
	return &logBatch{
		Source:       "docker containers",
		Lines:        out,
		Times:        times,
		Streams:      streamIDs,
		Reset:        reset,
		Next:         next,
		InputDropped: inputDropped,
	}, more, nil
}

func drainGoneDockerContainer(ctx context.Context, id string, position dockerLogCursor, budget, lineBudget int) ([]dockerLogLine, dockerLogCursor, bool, uint64, error) {
	if position.Driver == "json-file" && position.LogPath != "" && position.File != nil {
		if fileInfo, err := os.Stat(position.LogPath); err == nil && fileInfo.Mode().IsRegular() {
			batch, more, err := followFileWithLimits("docker-json-file:"+id, position.LogPath, "", position.File, budget, lineBudget)
			if err != nil {
				return nil, position, false, 0, err
			}
			updated := position
			updated.File = &batch.Next
			lines, err := decodeDockerJSONLines(id, position.Name, batch.Lines, &updated)
			return lines, updated, more, batch.InputDropped, err
		}
	}
	rawLines, times, _, more, err := containerRead(
		ctx, id, position.Since, position.Seen, position.DockerCursor == 0, true,
		"--since", position.Since.Format(time.RFC3339Nano), "robin-agent-budget="+strconv.Itoa(budget), "robin-agent-lines="+strconv.Itoa(lineBudget),
	)
	if err != nil {
		return nil, position, false, 0, err
	}
	updated := position
	updated.File = nil
	lines := make([]dockerLogLine, 0, len(rawLines))
	for i, line := range rawLines {
		if i >= len(times) {
			break
		}
		lines = append(lines, dockerLogLine{id: id, name: position.Name, line: line, at: times[i]})
	}
	return lines, updated, more, 0, nil
}

func decodeDockerJSONLines(id, name string, rawLines []string, position *dockerLogCursor) ([]dockerLogLine, error) {
	lines := make([]dockerLogLine, 0, len(rawLines))
	for _, raw := range rawLines {
		var record dockerJSONLogLine
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			return nil, fmt.Errorf("invalid Docker json-file record for %s", id)
		}
		at, err := time.Parse(time.RFC3339Nano, record.Time)
		if err != nil {
			return nil, fmt.Errorf("invalid Docker json-file timestamp for %s", id)
		}
		if position.ResumeActive {
			if at.Before(position.ResumeSince) {
				continue
			}
			if at.Equal(position.ResumeSince) && (position.ResumeLegacy || position.ResumeSkipped < position.ResumeSeen) {
				position.ResumeSkipped++
				continue
			}
			position.ResumeActive = false
		}
		line := strings.TrimSuffix(strings.TrimSuffix(record.Log, "\n"), "\r")
		lines = append(lines, dockerLogLine{id: id, name: name, line: line, at: at})
	}
	return lines, nil
}
