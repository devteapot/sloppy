package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

type TransportDesc struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
	URL  string `json:"url,omitempty"`
}

type Descriptor struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Description  string        `json:"description,omitempty"`
	SlopVersion  string        `json:"slop_version,omitempty"`
	Transport    TransportDesc `json:"transport"`
	PID          int           `json:"pid,omitempty"`
	Capabilities []string      `json:"capabilities,omitempty"`
}

func DiscoverSessionProviders() ([]Descriptor, error) {
	var dirs []string
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".slop", "providers"))
	}
	dirs = append(dirs, filepath.Join(os.TempDir(), "slop", "providers"))

	var providers []Descriptor
	seen := map[string]bool{}

	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}

			data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}

			var descriptor Descriptor
			if err := json.Unmarshal(data, &descriptor); err != nil {
				continue
			}

			if descriptor.ID == "" || seen[descriptor.ID] || !looksLikeSessionProvider(descriptor) {
				continue
			}

			if descriptor.PID > 0 && !isProcessAlive(descriptor.PID) {
				continue
			}

			seen[descriptor.ID] = true
			providers = append(providers, descriptor)
		}
	}

	sort.Slice(providers, func(i, j int) bool {
		left := providers[i].Name
		if left == "" {
			left = providers[i].ID
		}
		right := providers[j].Name
		if right == "" {
			right = providers[j].ID
		}
		return left < right
	})

	return providers, nil
}

func (d Descriptor) Address() string {
	switch d.Transport.Type {
	case "unix":
		return d.Transport.Path
	case "ws":
		return d.Transport.URL
	default:
		return ""
	}
}

func looksLikeSessionProvider(descriptor Descriptor) bool {
	if strings.HasPrefix(descriptor.ID, "sloppy-session-") {
		return true
	}

	name := strings.ToLower(descriptor.Name)
	return strings.Contains(name, "sloppy") && strings.Contains(name, "session")
}

func isProcessAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}

	err = process.Signal(syscall.Signal(0))
	return err == nil
}
