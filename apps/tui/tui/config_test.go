package tui

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadTuiSettingsPrefersWorkspaceLeader(t *testing.T) {
	tempDir := t.TempDir()
	homeConfigPath := filepath.Join(tempDir, "home.yaml")
	workspaceConfigPath := filepath.Join(tempDir, "workspace.yaml")

	if err := os.WriteFile(homeConfigPath, []byte("tui:\n  keybinds:\n    leader: ctrl+g\n"), 0o644); err != nil {
		t.Fatalf("write home config: %v", err)
	}
	if err := os.WriteFile(workspaceConfigPath, []byte("tui:\n  keybinds:\n    leader: ctrl+y\n"), 0o644); err != nil {
		t.Fatalf("write workspace config: %v", err)
	}

	settings, err := loadTuiSettingsFromPaths(homeConfigPath, workspaceConfigPath)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if settings.Keybinds.Leader != "ctrl+y" {
		t.Fatalf("expected workspace leader override, got %q", settings.Keybinds.Leader)
	}
}

func TestWriteTuiSettingsPreservesExistingConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	initialConfig := []byte("llm:\n  provider: openai\n  model: gpt-5.4\n")
	if err := os.WriteFile(configPath, initialConfig, 0o644); err != nil {
		t.Fatalf("write initial config: %v", err)
	}

	if err := writeTuiSettingsToPath(configPath, TuiSettings{Keybinds: KeybindSettings{Leader: "ctrl+x"}}); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	values, err := readConfigMap(configPath)
	if err != nil {
		t.Fatalf("read merged config: %v", err)
	}
	leader, ok := nestedString(values, "tui", "keybinds", "leader")
	if !ok || leader != "ctrl+x" {
		t.Fatalf("expected persisted leader key, got %q", leader)
	}
	provider, ok := nestedString(values, "llm", "provider")
	if !ok || provider != "openai" {
		t.Fatalf("expected llm config to be preserved, got %q", provider)
	}
}

func TestValidateLeaderKeyRejectsBareLetters(t *testing.T) {
	if err := validateLeaderKey("x"); err == nil {
		t.Fatalf("expected bare letter leader to be rejected")
	}
}
