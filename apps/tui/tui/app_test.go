package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestComposeAcceptsCharacterKeys(t *testing.T) {
	app := NewApp("unix:///tmp/sloppy.sock")
	app.mode = "session"
	app.focus = paneComposer
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	updated := updatedModel.(App)

	if updated.sessionScreen != "main" {
		t.Fatalf("expected compose typing to stay on main session screen, got %q", updated.sessionScreen)
	}
	if updated.input.Value() != "s" {
		t.Fatalf("expected compose input to receive typed key, got %q", updated.input.Value())
	}
}

func TestRejectPromptAcceptsCharacterKeys(t *testing.T) {
	app := NewApp("unix:///tmp/sloppy.sock")
	app.mode = "session"
	app.rejectApprovalID = "approval-1"
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	updated := updatedModel.(App)

	if updated.rejectApprovalID != "approval-1" {
		t.Fatalf("expected reject prompt to remain open, got %q", updated.rejectApprovalID)
	}
	if updated.rejectInput.Value() != "q" {
		t.Fatalf("expected reject input to receive typed key, got %q", updated.rejectInput.Value())
	}
}

func TestProfileFormAcceptsCharacterKeys(t *testing.T) {
	app := NewApp("unix:///tmp/sloppy.sock")
	app.mode = "session"
	app.sessionScreen = "profiles"
	app.profileFocus = profileForm
	app.profileFieldFocus = 0
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	updated := updatedModel.(App)

	if updated.sessionScreen != "profiles" {
		t.Fatalf("expected profile typing to stay in profile manager, got %q", updated.sessionScreen)
	}
	if updated.profileLabelInput.Value() != "s" {
		t.Fatalf("expected profile label input to receive typed key, got %q", updated.profileLabelInput.Value())
	}
}
