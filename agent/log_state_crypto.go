package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// Incomplete entries are encrypted separately from masked pending batches and
// bound to their service and stream.
func (s *logStateStore) logStateCipher(create bool) (cipher.AEAD, error) {
	path := s.path + ".key"
	key, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) && create {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, fmt.Errorf("generate log state key: %w", err)
		}
		if err = writeFileAtomic(path, key); err != nil {
			return nil, fmt.Errorf("persist log state key to %s: %w", path, err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("read log state key from %s: %w", path, err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("invalid log state key in %s", path)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialize log state cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

func transformLogPipeline(pipeline logPipelineState, serviceID string, aead cipher.AEAD, encrypt bool) (logPipelineState, error) {
	transform := func(stream logStreamState, streamID string) (logStreamState, error) {
		if !stream.HeldOpen {
			if stream.HeldRawEncrypted != "" || stream.HeldLineEncrypted != "" {
				return stream, errors.New("encrypted log entry has no open entry")
			}
			return stream, nil
		}
		if aead == nil {
			return stream, errors.New("log state key is unavailable")
		}
		additionalData := []byte(serviceID + "\x00" + streamID)
		lineData := append(append([]byte(nil), additionalData...), "\x00line"...)
		if encrypt {
			seal := func(value string, associated []byte) (string, error) {
				nonce := make([]byte, aead.NonceSize())
				if _, err := rand.Read(nonce); err != nil {
					return "", fmt.Errorf("generate log state nonce: %w", err)
				}
				return base64.RawStdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(value), associated)), nil
			}
			var err error
			if stream.HeldRawEncrypted, err = seal(stream.HeldRaw, additionalData); err != nil {
				return stream, err
			}
			if stream.HeldLineEncrypted, err = seal(stream.HeldLine, lineData); err != nil {
				return stream, err
			}
			stream.HeldRaw, stream.HeldLine = "", ""
			return stream, nil
		}
		open := func(value string, associated []byte) (string, error) {
			sealed, err := base64.RawStdEncoding.DecodeString(value)
			if err != nil || len(sealed) < aead.NonceSize() {
				return "", errors.New("invalid encrypted log entry")
			}
			plain, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], associated)
			if err != nil {
				return "", fmt.Errorf("decrypt held log entry: %w", err)
			}
			return string(plain), nil
		}
		raw, err := open(stream.HeldRawEncrypted, additionalData)
		if err != nil {
			return stream, err
		}
		if stream.HeldLineEncrypted != "" {
			if stream.HeldLine != "" {
				return stream, errors.New("encrypted log entry also has plaintext output")
			}
			if stream.HeldLine, err = open(stream.HeldLineEncrypted, lineData); err != nil {
				return stream, err
			}
		}
		stream.HeldRaw, stream.HeldRawEncrypted, stream.HeldLineEncrypted = raw, "", ""
		return stream, nil
	}

	var err error
	pipeline.logStreamState, err = transform(pipeline.logStreamState, "")
	if err != nil {
		return pipeline, err
	}
	if pipeline.Streams != nil {
		streams := make(map[string]logStreamState, len(pipeline.Streams))
		for id, stream := range pipeline.Streams {
			streams[id], err = transform(stream, id)
			if err != nil {
				return pipeline, fmt.Errorf("stream %s: %w", id, err)
			}
		}
		pipeline.Streams = streams
	}
	return pipeline, nil
}

func logPipelineHasOpenEntry(pipeline logPipelineState) bool {
	if pipeline.HeldOpen {
		return true
	}
	for _, stream := range pipeline.Streams {
		if stream.HeldOpen {
			return true
		}
	}
	return false
}

func transformLogService(state *logServiceState, serviceID string, aead cipher.AEAD, encrypt bool) (*logServiceState, error) {
	copyState := *state
	var err error
	copyState.Pipeline, err = transformLogPipeline(state.Pipeline, serviceID, aead, encrypt)
	if err != nil {
		return nil, err
	}
	copyBatch := func(batch *logBatch) (*logBatch, error) {
		if batch == nil {
			return nil, nil
		}
		copy := *batch
		copy.Pipeline, err = transformLogPipeline(batch.Pipeline, serviceID, aead, encrypt)
		return &copy, err
	}
	if copyState.Pending, err = copyBatch(state.Pending); err != nil {
		return nil, err
	}
	if state.PendingQueue != nil {
		copyState.PendingQueue = make([]*logBatch, len(state.PendingQueue))
		for i, batch := range state.PendingQueue {
			if copyState.PendingQueue[i], err = copyBatch(batch); err != nil {
				return nil, err
			}
		}
	}
	return &copyState, nil
}

func logServiceHasOpenEntry(state *logServiceState) bool {
	if logPipelineHasOpenEntry(state.Pipeline) || state.Pending != nil && logPipelineHasOpenEntry(state.Pending.Pipeline) {
		return true
	}
	for _, batch := range state.PendingQueue {
		if logPipelineHasOpenEntry(batch.Pipeline) {
			return true
		}
	}
	return false
}
