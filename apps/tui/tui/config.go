package tui

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const defaultLeaderKey = "ctrl+x"

var functionKeyPattern = regexp.MustCompile(`^f\d+$`)

type KeybindSettings struct {
	Leader string
}

type TuiSettings struct {
	Keybinds KeybindSettings
}

func defaultTuiSettings() TuiSettings {
	return TuiSettings{
		Keybinds: KeybindSettings{
			Leader: defaultLeaderKey,
		},
	}
}

func loadTuiSettings(cwd string) (TuiSettings, error) {
	homeConfigPath, err := homeConfigPath()
	if err != nil {
		return defaultTuiSettings(), err
	}
	return loadTuiSettingsFromPaths(homeConfigPath, workspaceConfigPath(cwd))
}

func loadTuiSettingsFromPaths(homeConfig string, workspaceConfig string) (TuiSettings, error) {
	settings := defaultTuiSettings()
	homeValues, err := readConfigMap(homeConfig)
	if err != nil {
		return settings, err
	}
	workspaceValues, err := readConfigMap(workspaceConfig)
	if err != nil {
		return settings, err
	}

	merged := deepMergeMaps(homeValues, workspaceValues)
	leader, ok := nestedString(merged, "tui", "keybinds", "leader")
	if !ok || strings.TrimSpace(leader) == "" {
		return settings, nil
	}

	normalized := normalizeLeaderKey(leader)
	if err := validateLeaderKey(normalized); err != nil {
		return settings, fmt.Errorf("invalid tui.keybinds.leader: %w", err)
	}
	settings.Keybinds.Leader = normalized
	return settings, nil
}

func writeHomeTuiSettings(settings TuiSettings) error {
	homeConfigPath, err := homeConfigPath()
	if err != nil {
		return err
	}
	return writeTuiSettingsToPath(homeConfigPath, settings)
}

func writeTuiSettingsToPath(configPath string, settings TuiSettings) error {
	leader := normalizeLeaderKey(settings.Keybinds.Leader)
	if err := validateLeaderKey(leader); err != nil {
		return err
	}

	configValues, err := readConfigMap(configPath)
	if err != nil {
		return err
	}
	setNestedValue(configValues, []string{"tui", "keybinds", "leader"}, leader)

	raw, err := yaml.Marshal(configValues)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	if err := os.WriteFile(configPath, raw, 0o644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

func normalizeLeaderKey(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}

func validateLeaderKey(key string) error {
	normalized := normalizeLeaderKey(key)
	if normalized == "" {
		return errors.New("leader key cannot be empty")
	}

	if reason, blocked := disallowedLeaderKeys()[normalized]; blocked {
		return errors.New(reason)
	}

	tokens := strings.Split(normalized, "+")
	lastToken := tokens[len(tokens)-1]
	if isDisallowedLeaderToken(lastToken) {
		return fmt.Errorf("%q is reserved for direct navigation or editing", normalized)
	}

	if functionKeyPattern.MatchString(lastToken) {
		return nil
	}

	hasCtrlOrAlt := false
	for _, token := range tokens[:len(tokens)-1] {
		if token == "ctrl" || token == "alt" {
			hasCtrlOrAlt = true
		}
	}
	if !hasCtrlOrAlt {
		return errors.New("leader key must include ctrl or alt, or be a function key")
	}
	return nil
}

func disallowedLeaderKeys() map[string]string {
	return map[string]string{
		"ctrl+a":      "ctrl+a is reserved for text input navigation",
		"ctrl+b":      "ctrl+b is reserved for text input navigation",
		"ctrl+c":      "ctrl+c is reserved for quitting",
		"ctrl+d":      "ctrl+d is reserved for text input editing",
		"ctrl+e":      "ctrl+e is reserved for text input navigation",
		"ctrl+f":      "ctrl+f is reserved for text input navigation",
		"ctrl+h":      "ctrl+h is reserved for text input editing",
		"ctrl+k":      "ctrl+k is reserved for text input editing",
		"ctrl+left":   "ctrl+left is reserved for text input navigation",
		"ctrl+n":      "ctrl+n is reserved for text input suggestions",
		"ctrl+p":      "ctrl+p is reserved for text input suggestions",
		"ctrl+right":  "ctrl+right is reserved for text input navigation",
		"ctrl+u":      "ctrl+u is reserved for text input editing",
		"ctrl+v":      "ctrl+v is reserved for text input paste",
		"ctrl+w":      "ctrl+w is reserved for text input editing",
		"alt+b":       "alt+b is reserved for text input navigation",
		"alt+d":       "alt+d is reserved for text input editing",
		"alt+delete":  "alt+delete is reserved for text input editing",
		"alt+f":       "alt+f is reserved for text input navigation",
		"alt+left":    "alt+left is reserved for text input navigation",
		"alt+right":   "alt+right is reserved for text input navigation",
		"alt+space":   "alt+space is reserved by many terminals and window managers",
		"backspace":   "backspace is reserved for text input editing",
		"delete":      "delete is reserved for text input editing",
		"down":        "down is reserved for direct navigation",
		"end":         "end is reserved for text input navigation",
		"enter":       "enter is reserved for direct actions",
		"esc":         "esc is reserved for direct actions",
		"home":        "home is reserved for text input navigation",
		"left":        "left is reserved for direct navigation",
		"pgdown":      "pgdown is reserved for direct navigation",
		"pgup":        "pgup is reserved for direct navigation",
		"right":       "right is reserved for direct navigation",
		"shift+down":  "shift+down is reserved for pane navigation",
		"shift+left":  "shift+left is reserved for pane navigation",
		"shift+right": "shift+right is reserved for pane navigation",
		"shift+tab":   "shift+tab is reserved for direct navigation",
		"shift+up":    "shift+up is reserved for pane navigation",
		"tab":         "tab is reserved for direct navigation",
		"up":          "up is reserved for direct navigation",
	}
}

func isDisallowedLeaderToken(token string) bool {
	return token == "tab" ||
		token == "enter" ||
		token == "esc" ||
		token == "up" ||
		token == "down" ||
		token == "left" ||
		token == "right" ||
		token == "home" ||
		token == "end" ||
		token == "pgup" ||
		token == "pgdown"
}

func homeConfigPath() (string, error) {
	homeDirectory, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(homeDirectory, ".sloppy", "config.yaml"), nil
}

func workspaceConfigPath(cwd string) string {
	if cwd == "" {
		workingDirectory, err := os.Getwd()
		if err == nil {
			cwd = workingDirectory
		}
	}
	if cwd == "" {
		cwd = "."
	}
	return filepath.Join(cwd, ".sloppy", "config.yaml")
}

func readConfigMap(configPath string) (map[string]any, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("read config %s: %w", configPath, err)
	}

	values := map[string]any{}
	if err := yaml.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", configPath, err)
	}
	return values, nil
}

func deepMergeMaps(base map[string]any, override map[string]any) map[string]any {
	merged := cloneMap(base)
	for key, value := range override {
		overrideMap, overrideIsMap := value.(map[string]any)
		baseMap, baseIsMap := merged[key].(map[string]any)
		if overrideIsMap && baseIsMap {
			merged[key] = deepMergeMaps(baseMap, overrideMap)
			continue
		}
		merged[key] = value
	}
	return merged
}

func cloneMap(values map[string]any) map[string]any {
	cloned := make(map[string]any, len(values))
	for key, value := range values {
		nested, ok := value.(map[string]any)
		if ok {
			cloned[key] = cloneMap(nested)
			continue
		}
		cloned[key] = value
	}
	return cloned
}

func nestedString(values map[string]any, path ...string) (string, bool) {
	current := values
	for index, key := range path {
		value, ok := current[key]
		if !ok {
			return "", false
		}
		if index == len(path)-1 {
			text, ok := value.(string)
			return text, ok
		}
		next, ok := value.(map[string]any)
		if !ok {
			return "", false
		}
		current = next
	}
	return "", false
}

func setNestedValue(values map[string]any, path []string, value any) {
	current := values
	for index, key := range path {
		if index == len(path)-1 {
			current[key] = value
			return
		}
		next, ok := current[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			current[key] = next
		}
		current = next
	}
}
