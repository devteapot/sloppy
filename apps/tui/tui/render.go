package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"
	"github.com/devteapot/sloppy/apps/tui/session"
)

func renderTranscriptEntry(entry session.TranscriptEntry, selected bool, width int) string {
	lines := transcriptEntryLines(entry, width, selected)
	content := strings.Join(lines, "\n")
	style := rowStyle.Width(width)
	if selected {
		style = selectedRowStyle.Width(width)
	} else if entry.Role == "assistant" {
		style = style.Background(lipgloss.Color(colorSurfaceContainer))
	}
	return style.Render(content)
}

func transcriptEntryLines(entry session.TranscriptEntry, width int, selected bool) []string {
	title := strings.ToUpper(entry.Role)
	if entry.Author != "" && !strings.EqualFold(entry.Author, entry.Role) {
		title = fmt.Sprintf("%s · %s", title, entry.Author)
	}
	status := statusStyle(entry.State).Render(strings.ToUpper(entry.State))
	message := normalizeWrappedText(entry.Text)
	if strings.TrimSpace(message) == "" {
		message = "No text content."
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
	}
	lines = append(lines, wrapIndentedText(message, "  ", maxInt(width-4, 1))...)

	if entry.State == "streaming" {
		lines = append(lines, "  "+ghostTextStyle.Render("\u258d streaming..."))
	}

	return lines
}

func transcriptEntryHeight(entry session.TranscriptEntry, width int) int {
	return len(transcriptEntryLines(entry, width, false))
}

func renderApprovalEntry(entry session.ApprovalEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(strings.ReplaceAll(entry.Status, "_", " ")))
	title := fmt.Sprintf("%s:%s", entry.Provider, entry.Action)
	titleRenderer := labelStyle
	if entry.Dangerous && entry.Status == "pending" {
		title = title + " \u26a0"
		titleRenderer = dangerStyle
	} else if entry.Dangerous {
		title = title + " !"
	}
	detail := joinNonEmpty(" | ", entry.Reason, entry.Path, entry.ParamsPreview)
	if detail == "" {
		detail = entry.Path
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), titleRenderer.Render(title), status),
		"  " + truncate(compact(detail), width-4),
	}

	// Dangerous pending approvals get elevated background even when unselected.
	if entry.Dangerous && entry.Status == "pending" && !selected {
		content := strings.Join(lines, "\n")
		style := rowStyle.Width(width).Background(lipgloss.Color(colorSurfaceHigh))
		return style.Render(content)
	}

	return renderListItem(selected, width, lines)
}

func renderOrchestrationGateEntry(entry session.OrchestrationGateEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(strings.ReplaceAll(entry.Status, "_", " ")))
	title := entry.Type
	if title == "" {
		title = "gate"
	}
	detail := joinNonEmpty(" | ", entry.Summary, entry.SubjectRef)
	if detail == "" {
		detail = entry.ID
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), warningStyle.Render("GATE "+title), status),
		"  " + truncate(compact(detail), width-4),
	}
	return renderListItem(selected, width, lines)
}

func renderDigestActionEntry(entry session.DigestActionEntry, selected bool, width int) string {
	urgency := statusStyle(entry.Urgency).Render(strings.ToUpper(strings.ReplaceAll(entry.Urgency, "_", " ")))
	title := entry.Label
	if title == "" {
		title = entry.Kind
	}
	detail := joinNonEmpty(" | ", entry.TargetRef, joinNonEmpty(" ", entry.ActionPath, entry.ActionName))
	if detail == "" {
		detail = entry.ID
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render("ACTION "+title), urgency),
		"  " + truncate(compact(detail), width-4),
	}
	return renderListItem(selected, width, lines)
}

func renderTaskEntry(entry session.TaskEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(entry.Status))
	title := entry.Provider
	if title == "" {
		title = "task"
	}
	detailParts := []string{entry.ProviderTaskID}
	if entry.HasProgress {
		detailParts = append(detailParts, formatPercent(entry.Progress))
	}
	if entry.Error != "" {
		detailParts = append(detailParts, entry.Error)
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
		"  " + truncate(compact(joinNonEmpty(" | ", entry.Message, strings.Join(detailParts, " | "))), width-4),
	}
	return renderListItem(selected, width, lines)
}

func renderActivityEntry(entry session.ActivityEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(strings.ReplaceAll(entry.Status, "_", " ")))
	title := strings.ToUpper(strings.ReplaceAll(entry.Kind, "_", " "))
	detail := joinNonEmpty(" | ", entry.Summary, joinNonEmpty(" ", entry.Provider, entry.Path, entry.Action))
	if detail == "" {
		detail = entry.Summary
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
		"  " + truncate(compact(detail), width-4),
	}
	return renderListItem(selected, width, lines)
}

func renderAppEntry(entry session.AppEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(strings.ReplaceAll(entry.Status, "_", " ")))
	title := entry.Name
	if title == "" {
		title = entry.ID
	}
	line := fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status)
	if entry.ID != "" && entry.ID != title {
		line = fmt.Sprintf("%s  %s", line, mutedStyle.Render(entry.ID))
	}
	detail := entry.Transport
	if entry.LastError != "" {
		detail = joinNonEmpty(" | ", detail, entry.LastError)
	}
	if detail == "" {
		detail = entry.ID
	}

	return renderListItem(selected, width, []string{
		line,
		"  " + truncate(compact(detail), maxInt(width-2, 1)),
	})
}

func renderListItem(selected bool, width int, lines []string) string {
	content := strings.Join(lines, "\n")
	style := rowStyle.Width(width)
	if selected {
		style = selectedRowStyle.Width(width)
	}
	return style.Render(content)
}

func renderMetaPair(label string, value string, tone string) string {
	styledValue := codeStyle.Render(value)
	if tone != "" {
		styledValue = statusStyle(tone).Render(value)
	}
	return fmt.Sprintf("%s %s", metaLabelStyle.Render(strings.ToUpper(label)), styledValue)
}

func paneHeader(title string, focused bool, detail string) string {
	headerStyle := titleStyle
	marker := ghostTextStyle.Render(" ")
	if focused {
		headerStyle = accentTitleStyle
		marker = selectedAccentStyle.Render("|")
	}

	text := fmt.Sprintf("%s %s", marker, title)
	if detail != "" {
		text = fmt.Sprintf("%s  %s", text, mutedStyle.Render(detail))
	}
	return headerStyle.Render(text)
}

func listPrefix(selected bool) string {
	if selected {
		return selectedAccentStyle.Render("->")
	}
	return ghostTextStyle.Render("\u00b7")
}

func statusStyle(status string) lipgloss.Style {
	switch status {
	case "active", "complete", "completed", "approved", "ok", "idle":
		return successStyle
	case "running", "streaming", "accepted", "pending", "waiting_approval", "normal", "on_track":
		return keyStyle
	case "failed", "error", "rejected", "expired", "cancelled", "high", "blocked", "halted", "at_risk":
		return dangerStyle
	default:
		return mutedStyle
	}
}

func renderInputRow(label string, input textinput.Model, focused bool, editing bool, width int) string {
	marker := ghostTextStyle.Render("\u00b7")
	labelRenderer := metaLabelStyle
	if focused {
		marker = selectedAccentStyle.Render("->")
		labelRenderer = selectedAccentStyle
	}
	if editing {
		marker = keyStyle.Render("*>")
	}

	row := fmt.Sprintf("%s %s %s", marker, lipgloss.NewStyle().Width(10).Render(labelRenderer.Render(strings.ToUpper(label))), input.View())
	style := rowStyle.Width(width)
	if focused {
		style = selectedRowStyle.Width(width)
	}
	return style.Render(row)
}

func renderSettingRow(label string, value string, status string, width int) string {
	lines := []string{
		fmt.Sprintf("%s %s  %s", selectedAccentStyle.Render("->"), labelStyle.Render(strings.ToUpper(label)), codeStyle.Render(value)),
		"  " + compact(status),
	}
	return selectedRowStyle.Width(width).Render(strings.Join(lines, "\n"))
}

func renderProfileEntry(entry session.LlmProfileEntry, selected bool, width int) string {
	status := statusStyle(map[bool]string{true: "ready", false: "needs_credentials"}[entry.Ready]).Render(strings.ToUpper(strings.ReplaceAll(map[bool]string{true: "ready", false: "needs_credentials"}[entry.Ready], "_", " ")))
	title := entry.Label
	if title == "" {
		title = strings.TrimSpace(fmt.Sprintf("%s %s", entry.Provider, entry.Model))
	}
	detailParts := []string{joinNonEmpty(" ", entry.Provider, entry.Model)}
	if entry.IsDefault {
		detailParts = append(detailParts, "default")
	}
	if entry.Origin != "" {
		detailParts = append(detailParts, entry.Origin)
	}
	if entry.KeySource != "" {
		detailParts = append(detailParts, entry.KeySource)
	}
	if entry.APIKeyEnv != "" {
		detailParts = append(detailParts, entry.APIKeyEnv)
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
		"  " + truncate(compact(strings.Join(detailParts, " | ")), width-4),
	}
	return renderListItem(selected, width, lines)
}

func scrollIndicator(start int, end int, total int) string {
	if total <= 0 || (start == 0 && end >= total) {
		return ""
	}
	if start > 0 && end < total {
		return mutedStyle.Render(fmt.Sprintf("  \u2191 %d more \u00b7 \u2193 %d more", start, total-end))
	}
	if start > 0 {
		return mutedStyle.Render(fmt.Sprintf("  \u2191 %d more", start))
	}
	return mutedStyle.Render(fmt.Sprintf("  \u2193 %d more", total-end))
}

func styledHelp(pairs ...string) string {
	parts := make([]string, 0, len(pairs)/2)
	for i := 0; i < len(pairs)-1; i += 2 {
		parts = append(parts, fmt.Sprintf("%s %s",
			helpKeyStyle.Render(pairs[i]),
			helpStyle.Render(pairs[i+1]),
		))
	}
	return strings.Join(parts, "  ")
}

func (a App) sessionHelp() string {
	if a.rejectPromptOpen() {
		if a.rejectEditing {
			return styledHelp("enter", "reject", "esc", "stop editing", "ctrl+c", "quit")
		}
		return styledHelp("enter", "edit", "esc", "cancel", "ctrl+c", "quit")
	}

	if a.leaderPending {
		switch a.focus {
		case paneApprovals:
			return styledHelp("a", "approve", "r", "reject", "p", "profiles", "s", "settings", "t", "cancel turn", "q", "quit")
		case paneOrchestration:
			return styledHelp("a", "accept gate", "r", "reject gate", "d", "run digest", "p", "profiles", "s", "settings", "q", "quit")
		case paneTasks:
			return styledHelp("c", "cancel task", "p", "profiles", "s", "settings", "t", "cancel turn", "q", "quit")
		default:
			return styledHelp("p", "profiles", "s", "settings", "i", "compose", "t", "cancel turn", "q", "quit")
		}
	}

	switch a.focus {
	case paneComposer:
		return styledHelp("shift+arrows", "panes", "tab", "cycle", "enter", "send", a.tuiSettings.Keybinds.Leader, "actions", "esc", "back", "ctrl+c", "quit")
	case paneApprovals:
		return styledHelp("arrows", "move", "shift+arrows", "panes", "enter", "approve", a.tuiSettings.Keybinds.Leader, "actions", "esc", "back")
	case paneOrchestration:
		return styledHelp("arrows", "move", "shift+arrows", "panes", "enter", "act", a.tuiSettings.Keybinds.Leader, "actions", "esc", "back")
	case paneTasks:
		return styledHelp("arrows", "move", "shift+arrows", "panes", "enter", "cancel task", a.tuiSettings.Keybinds.Leader, "actions", "esc", "back")
	default:
		return styledHelp("arrows", "move", "shift+arrows", "panes", "left/right", "cycle", a.tuiSettings.Keybinds.Leader, "actions", "esc", "back")
	}
}

func (a App) profileHelp() string {
	if a.leaderPending {
		if a.profileFocus == profileForm {
			return styledHelp("w", "save", "s", "settings", "q", "quit")
		}
		return styledHelp("n", "new", "f", "default", "d", "delete", "x", "drop key", "s", "settings", "q", "quit")
	}

	if a.profileFocus == profileList {
		if a.state.CanSendMessage {
			return styledHelp("arrows", "move", "enter", "open form", "right", "form", a.leaderBinding("n"), "new", a.leaderBinding("s"), "settings", "esc", "back")
		}
		return styledHelp("arrows", "move", "enter", "open form", "right", "form", a.leaderBinding("n"), "new", a.leaderBinding("s"), "settings", "ctrl+c", "quit")
	}

	if a.profileFieldEditing {
		return styledHelp("type", "value", "enter", "finish", "esc", "stop editing", a.leaderBinding("w"), "save")
	}

	if a.state.CanSendMessage {
		return styledHelp("arrows", "fields", "tab", "next", "enter", "edit", "left", "list", a.leaderBinding("w"), "save", a.leaderBinding("s"), "settings", "esc", "back")
	}
	return styledHelp("arrows", "fields", "tab", "next", "enter", "edit", "left", "list", a.leaderBinding("w"), "save", a.leaderBinding("s"), "settings", "esc", "list", "ctrl+c", "quit")
}

func (a App) settingsHelp() string {
	if a.settingsCapturing {
		return styledHelp("press", "desired leader", "esc", "cancel", "ctrl+c", "quit")
	}
	return styledHelp("enter", "capture", "esc", "back", "ctrl+c", "quit")
}

func (a App) leaderBinding(key string) string {
	if strings.TrimSpace(key) == "" {
		return a.tuiSettings.Keybinds.Leader
	}
	return fmt.Sprintf("%s %s", a.tuiSettings.Keybinds.Leader, key)
}
