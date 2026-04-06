package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/devteapot/sloppy/apps/tui/session"
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

func TestTranscriptEntryLinesWrapLongMessages(t *testing.T) {
	entry := session.TranscriptEntry{
		Role:   "assistant",
		State:  "complete",
		Author: "claude-opus-4.6",
		Text:   "This is a long assistant response that should wrap instead of being truncated in the transcript pane.",
	}

	lines := transcriptEntryLines(entry, 24, false)
	if len(lines) <= 2 {
		t.Fatalf("expected wrapped transcript body lines, got %#v", lines)
	}

	body := strings.Join(lines[1:], "\n")
	if compact(body) != "This is a long assistant response that should wrap instead of being truncated in the transcript pane." {
		t.Fatalf("expected wrapped transcript to preserve the full message, got %q", body)
	}

	for _, line := range lines[1:] {
		if len([]rune(line)) > 22 {
			t.Fatalf("expected wrapped transcript body line to fit pane content, got %q", line)
		}
	}
}

func TestWindowBoundsByHeightsFitsRenderedTranscriptEntries(t *testing.T) {
	heights := []int{2, 4, 2}
	start, end := windowBoundsByHeights(heights, 1, 6)
	if start != 0 || end != 2 {
		t.Fatalf("expected bounds to keep the selected wrapped entry and only the rows that fit, got start=%d end=%d", start, end)
	}
}
