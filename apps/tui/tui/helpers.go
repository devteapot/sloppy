package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/x/ansi"
	"github.com/devteapot/sloppy/apps/tui/session"
)

func newCodeInput(placeholder string) textinput.Model {
	input := textinput.New()
	input.Placeholder = placeholder
	input.CharLimit = 4096
	input.Prompt = "> "
	input.PromptStyle = promptStyle
	input.TextStyle = codeStyle
	input.PlaceholderStyle = mutedStyle
	input.Cursor.Style = promptStyle
	return input
}

func nextPane(current paneFocus) paneFocus {
	if current == paneComposer {
		return paneTranscript
	}
	return current + 1
}

func previousPane(current paneFocus) paneFocus {
	if current == paneTranscript {
		return paneComposer
	}
	return current - 1
}

func clampIndex(index int, length int) int {
	if length == 0 {
		return 0
	}
	if index < 0 {
		return 0
	}
	if index >= length {
		return length - 1
	}
	return index
}

func clampRange(index int, length int) int {
	return clampIndex(index, length)
}

func preserveCursor(oldLength int, newLength int, cursor int) int {
	if newLength == 0 {
		return 0
	}
	if oldLength == 0 {
		return newLength - 1
	}
	if cursor >= oldLength-1 {
		return newLength - 1
	}
	return clampIndex(cursor, newLength)
}

func windowBounds(total int, cursor int, visible int) (int, int) {
	if total <= visible {
		return 0, total
	}
	if visible <= 1 {
		cursor = clampIndex(cursor, total)
		return cursor, cursor + 1
	}

	cursor = clampIndex(cursor, total)
	half := visible / 2
	start := cursor - half
	if start < 0 {
		start = 0
	}
	end := start + visible
	if end > total {
		end = total
		start = end - visible
	}
	if start < 0 {
		start = 0
	}
	return start, end
}

func windowBoundsByHeights(heights []int, cursor int, available int) (int, int) {
	if len(heights) == 0 || available <= 0 {
		return 0, 0
	}

	cursor = clampIndex(cursor, len(heights))
	start := cursor
	end := cursor + 1
	used := maxInt(heights[cursor], 1)
	if used >= available {
		return start, end
	}

	for {
		expanded := false
		if start > 0 {
			nextHeight := maxInt(heights[start-1], 1)
			if used+nextHeight <= available {
				start--
				used += nextHeight
				expanded = true
			}
		}
		if end < len(heights) {
			nextHeight := maxInt(heights[end], 1)
			if used+nextHeight <= available {
				used += nextHeight
				end++
				expanded = true
			}
		}
		if !expanded {
			break
		}
	}

	return start, end
}

func hasPendingApprovals(approvals []session.ApprovalEntry) bool {
	return firstPendingApprovalIndex(approvals) >= 0
}

func firstPendingApprovalIndex(approvals []session.ApprovalEntry) int {
	for index := range approvals {
		if approvals[index].Status == "pending" {
			return index
		}
	}
	return -1
}

func compact(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func normalizeWrappedText(text string) string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.Trim(normalized, "\n")
}

func wrapIndentedText(text string, prefix string, contentWidth int) []string {
	if contentWidth <= 0 {
		contentWidth = 1
	}

	rawLines := strings.Split(normalizeWrappedText(text), "\n")
	wrappedLines := make([]string, 0, len(rawLines))
	for _, rawLine := range rawLines {
		if rawLine == "" {
			wrappedLines = append(wrappedLines, prefix)
			continue
		}

		wrapped := ansi.Wrap(rawLine, contentWidth, "")
		for _, line := range strings.Split(wrapped, "\n") {
			wrappedLines = append(wrappedLines, prefix+line)
		}
	}

	if len(wrappedLines) == 0 {
		return []string{prefix}
	}

	return wrappedLines
}

// Non-transcript panes still truncate their detail rows. If those panes start
// surfacing longer content, they will need width-aware wrapping and height-based
// windowing like the transcript now uses.
func truncate(text string, width int) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	if width <= 3 {
		return string(runes[:width])
	}
	return string(runes[:width-3]) + "..."
}

func formatPercent(progress float64) string {
	return fmt.Sprintf("%d%%", int(progress*100))
}

func joinNonEmpty(separator string, values ...string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	return strings.Join(parts, separator)
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func blockHeight(content string) int {
	if content == "" {
		return 0
	}
	return strings.Count(content, "\n") + 1
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func isPaneNavigationKey(key string) bool {
	return key == "shift+up" || key == "shift+down" || key == "shift+left" || key == "shift+right"
}

// paneMinHeight returns the minimum pane height for layout calculations.
// Empty panes collapse to a small header; non-empty panes keep a usable size.
func paneMinHeight(itemCount int) int {
	if itemCount == 0 {
		return 3
	}
	return 6
}

// panePadW is the total horizontal overhead of paneStyle (left border + padding).
const panePadW = 5 // 1 left border + 2 left pad + 2 right pad

// panePadH is the total vertical overhead of paneStyle (padding only).
const panePadH = 2 // 1 top pad + 1 bottom pad
