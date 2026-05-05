package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/devteapot/sloppy/apps/tui/session"
)

func newTestApp() App {
	app := NewApp("unix:///tmp/sloppy.sock")
	app.tuiSettings = defaultTuiSettings()
	app.sessionErr = ""
	return app
}

func TestComposeAcceptsCharacterKeys(t *testing.T) {
	app := newTestApp()
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

func TestRejectPromptRequiresEnterToEdit(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.rejectApprovalID = "approval-1"
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	updated := updatedModel.(App)

	if updated.rejectApprovalID != "approval-1" {
		t.Fatalf("expected reject prompt to remain open, got %q", updated.rejectApprovalID)
	}
	if updated.rejectInput.Value() != "" {
		t.Fatalf("expected reject input to stay idle until enter, got %q", updated.rejectInput.Value())
	}
	if updated.rejectEditing {
		t.Fatalf("expected reject prompt to remain in browse mode")
	}
}

func TestRejectPromptAcceptsCharactersAfterEnter(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.rejectApprovalID = "approval-1"
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyEnter})
	updated := updatedModel.(App)
	updatedModel, _ = updated.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	updated = updatedModel.(App)

	if !updated.rejectEditing {
		t.Fatalf("expected reject prompt to enter editing mode after enter")
	}
	if updated.rejectInput.Value() != "q" {
		t.Fatalf("expected reject input to receive typed key after enter, got %q", updated.rejectInput.Value())
	}
}

func TestProfileFormRequiresEnterToEdit(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.sessionScreen = sessionScreenProfiles
	app.profileFocus = profileForm
	app.profileFieldFocus = 0
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	updated := updatedModel.(App)

	if updated.sessionScreen != sessionScreenProfiles {
		t.Fatalf("expected profile typing to stay in profile manager, got %q", updated.sessionScreen)
	}
	if updated.profileLabelInput.Value() != "" {
		t.Fatalf("expected profile label input to stay idle until enter, got %q", updated.profileLabelInput.Value())
	}
	if updated.profileFieldEditing {
		t.Fatalf("expected profile form to remain in browse mode")
	}
	if updated.profileLabelInput.Focused() {
		t.Fatalf("expected profile input to remain blurred until enter")
	}
}

func TestProfileFormAcceptsCharactersAfterEnter(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.sessionScreen = sessionScreenProfiles
	app.profileFocus = profileForm
	app.profileFieldFocus = 0
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyEnter})
	updated := updatedModel.(App)
	updatedModel, _ = updated.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	updated = updatedModel.(App)

	if !updated.profileFieldEditing {
		t.Fatalf("expected profile form to enter editing mode after enter")
	}
	if updated.profileLabelInput.Value() != "s" {
		t.Fatalf("expected profile label input to receive typed key after enter, got %q", updated.profileLabelInput.Value())
	}
	if !updated.profileLabelInput.Focused() {
		t.Fatalf("expected active profile input to be focused while editing")
	}
}

func TestLeaderSequenceOpensProfilesFromComposer(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.focus = paneComposer
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyCtrlX})
	updated := updatedModel.(App)
	updatedModel, _ = updated.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'p'}})
	updated = updatedModel.(App)

	if updated.sessionScreen != sessionScreenProfiles {
		t.Fatalf("expected leader+p to open profiles, got %q", updated.sessionScreen)
	}
	if updated.input.Value() != "" {
		t.Fatalf("expected leader sequence to not write into composer, got %q", updated.input.Value())
	}
}

func TestBareActionKeysDoNotStealComposerInput(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.focus = paneComposer
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'p'}})
	updated := updatedModel.(App)

	if updated.sessionScreen != sessionScreenMain {
		t.Fatalf("expected bare p to stay in the main session screen, got %q", updated.sessionScreen)
	}
	if updated.input.Value() != "p" {
		t.Fatalf("expected bare p to type into composer, got %q", updated.input.Value())
	}
}

func TestShiftArrowMovesFocusOutOfComposer(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.focus = paneComposer
	app.lastMainFocus = paneTasks
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyShiftUp})
	updated := updatedModel.(App)

	if updated.focus != paneTasks {
		t.Fatalf("expected shift+up to move focus back to the last main pane, got %v", updated.focus)
	}
	if updated.input.Focused() {
		t.Fatalf("expected composer input to blur after leaving the composer pane")
	}
}

func TestShiftArrowMovesFromTasksToApps(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.width = 140
	app.focus = paneTasks
	app.syncInputs()

	updatedModel, _ := app.updateSession(tea.KeyMsg{Type: tea.KeyShiftDown})
	updated := updatedModel.(App)

	if updated.focus != paneApps {
		t.Fatalf("expected shift+down to move focus from tasks to apps, got %v", updated.focus)
	}
}

func TestSessionViewRendersAppsPane(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.width = 140
	app.height = 40
	app.state = session.ViewState{
		SessionTitle:  "Nocturnal Session",
		SessionStatus: "active",
		TurnState:     "idle",
		Apps: []session.AppEntry{{
			ID:        "native-demo",
			Name:      "Native Demo",
			Transport: "unix:/tmp/native-demo.sock",
			Status:    "connected",
		}},
	}

	view := app.sessionView()
	if !strings.Contains(view, "Apps") {
		t.Fatalf("expected session view to render apps pane, got %q", view)
	}
	if !strings.Contains(view, "Native Demo") || !strings.Contains(view, "unix:/tmp/native-demo.sock") {
		t.Fatalf("expected session view to include app attachment details, got %q", view)
	}
}

func TestSessionViewRendersOrchestrationPane(t *testing.T) {
	app := newTestApp()
	app.mode = "session"
	app.width = 140
	app.height = 42
	app.state = session.ViewState{
		SessionTitle:  "Nocturnal Session",
		SessionStatus: "active",
		TurnState:     "idle",
		Orchestration: session.OrchestrationSummary{
			Available:          true,
			PlanID:             "plan-1",
			PlanStatus:         "active",
			LatestDigestID:     "digest-1",
			LatestDigestStatus: "blocked",
			Gates: []session.OrchestrationGateEntry{{
				ID:         "gate-1",
				Type:       "spec_accept",
				Status:     "open",
				SubjectRef: "spec:spec-1",
				Summary:    "Spec needs acceptance.",
				CanAccept:  true,
				CanReject:  true,
			}},
			DigestActions: []session.DigestActionEntry{{
				ID:         "action-gate-1-accept",
				Kind:       "accept_gate",
				Label:      "Accept spec_accept",
				TargetRef:  "gate:gate-1",
				ActionPath: "/gates/gate-1",
				ActionName: "resolve_gate",
				Urgency:    "high",
				CanRun:     true,
			}},
		},
	}

	view := app.sessionView()
	if !strings.Contains(view, "Orchestration") {
		t.Fatalf("expected session view to render orchestration pane, got %q", view)
	}
	if !strings.Contains(view, "Spec needs acceptance.") || !strings.Contains(view, "Accept spec_accept") {
		t.Fatalf("expected orchestration pane to include gates and digest actions, got %q", view)
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
