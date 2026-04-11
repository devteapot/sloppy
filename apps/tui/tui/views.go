package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func (a App) discoveryView() string {
	var lines []string
	lines = append(lines, "")
	lines = append(lines, accentTitleStyle.Render("  \u25c9 \u25c9"))
	lines = append(lines, "")
	lines = append(lines, accentTitleStyle.Render("Sloppy TUI"))
	lines = append(lines, mutedStyle.Render("Attach to a running agent-session provider"))
	lines = append(lines, "")

	if len(a.providers) == 0 {
		lines = append(lines, ghostTextStyle.Render("No session providers found."))
		lines = append(lines, ghostTextStyle.Render("Start a session server first, then press r to refresh."))
	} else {
		for i, descriptor := range a.providers {
			cursor := ghostTextStyle.Render("  ")
			if i == a.cursor {
				cursor = selectedAccentStyle.Render("->")
			}
			name := descriptor.Name
			if name == "" {
				name = descriptor.ID
			}
			lines = append(lines, fmt.Sprintf("%s %s  %s", cursor, titleStyle.Render(name), mutedStyle.Render(descriptor.Address())))
		}
	}

	if a.err != nil {
		lines = append(lines, "")
		lines = append(lines, dangerStyle.Render(a.err.Error()))
	}
	if a.sessionErr != "" {
		lines = append(lines, "")
		lines = append(lines, warningStyle.Render(a.sessionErr))
	}

	lines = append(lines, "")
	lines = append(lines, styledHelp("enter", "connect", "r", "refresh", "q", "quit"))
	return appStyle.Render(strings.Join(lines, "\n"))
}

func (a App) sessionView() string {
	width := a.width
	if width == 0 {
		width = 120
	}
	height := a.height
	if height == 0 {
		height = 36
	}

	bodyWidth := width - 4
	if bodyWidth < 1 {
		bodyWidth = 1
	}
	bodyHeight := height - 2
	if bodyHeight < 1 {
		bodyHeight = 1
	}

	header := a.sessionHeaderView(bodyWidth)
	headerHeight := blockHeight(header)

	composerHeight := 5
	if height > 40 {
		composerHeight = 6
	}
	if height > 60 {
		composerHeight = 8
	}

	mainHeight := maxInt(bodyHeight-headerHeight-composerHeight-4, 14)

	main := a.sessionMainView(bodyWidth, mainHeight)
	composer := composerStyle(a.focus == paneComposer).Width(bodyWidth).Render(a.composerView(bodyWidth - 4))

	content := lipgloss.JoinVertical(lipgloss.Left, header, "", main, "", composer)
	if a.rejectPromptOpen() {
		content = lipgloss.JoinVertical(
			lipgloss.Left,
			content,
			"",
			lipgloss.PlaceHorizontal(bodyWidth, lipgloss.Center, a.rejectPromptView(bodyWidth)),
		)
	}

	return appStyle.Render(content)
}

func (a App) sessionHeaderView(width int) string {
	title := a.state.SessionTitle
	if title == "" {
		title = "Session"
	}

	titleRenderer := titleStyle
	if a.state.TurnState == "waiting_approval" || a.state.TurnState == "running" {
		titleRenderer = accentTitleStyle
	}

	var lines []string
	lines = append(lines, titleRenderer.Render(title))

	meta := make([]string, 0, 4)
	if a.state.SessionStatus != "" {
		meta = append(meta, renderMetaPair("session", strings.ToUpper(a.state.SessionStatus), a.state.SessionStatus))
	}
	if a.state.Model != "" {
		meta = append(meta, renderMetaPair("model", a.state.Model, ""))
	}
	if a.state.TurnState != "" {
		meta = append(meta, renderMetaPair("turn", strings.ToUpper(strings.ReplaceAll(a.state.TurnState, "_", " ")), a.state.TurnState))
	}
	if a.state.CanCancelTurn {
		meta = append(meta, fmt.Sprintf("%s %s", metaLabelStyle.Render("TURN ACTION"), keyStyle.Render(a.leaderBinding("t"))))
	}
	if len(meta) > 0 {
		lines = append(lines, strings.Join(meta, "   "))
	}

	if a.state.TurnMessage != "" {
		lines = append(lines, mutedStyle.Render(a.state.TurnMessage))
	}
	if a.sessionErr != "" {
		lines = append(lines, dangerStyle.Render(a.sessionErr))
	}
	if a.state.Error != "" {
		lines = append(lines, warningStyle.Render(a.state.Error))
	}

	return lipgloss.NewStyle().Width(width).Render(strings.Join(lines, "\n"))
}

func (a App) sessionMainView(width int, height int) string {
	if width < 112 {
		return a.sessionMainNarrowView(width, height)
	}
	return a.sessionMainWideView(width, height)
}

func (a App) sessionMainNarrowView(width int, height int) string {
	approvalCount := len(a.state.Approvals)
	taskCount := len(a.state.Tasks)
	appCount := len(a.state.Apps)
	activityCount := len(a.state.Activity)

	approvalMin := paneMinHeight(approvalCount)
	taskMin := paneMinHeight(taskCount)
	appMin := paneMinHeight(appCount)
	activityMin := paneMinHeight(activityCount)

	railMin := approvalMin + taskMin + appMin + activityMin + 3
	transcriptHeight := maxInt(height-railMin-1, 8)
	remainingRail := maxInt(height-transcriptHeight-1, railMin)

	// Distribute rail height among panes, giving extra to non-empty ones.
	nonEmpty := 0
	for _, c := range []int{approvalCount, taskCount, appCount, activityCount} {
		if c > 0 {
			nonEmpty++
		}
	}
	extraPerPane := 0
	if nonEmpty > 0 {
		surplus := maxInt(remainingRail-railMin, 0)
		extraPerPane = surplus / nonEmpty
	}

	approvalHeight := approvalMin
	if approvalCount > 0 {
		approvalHeight += extraPerPane
	}
	taskHeight := taskMin
	if taskCount > 0 {
		taskHeight += extraPerPane
	}
	appHeight := appMin
	if appCount > 0 {
		appHeight += extraPerPane
	}
	activityHeight := maxInt(remainingRail-approvalHeight-taskHeight-appHeight-3, activityMin)

	transcript := paneStyle(a.focus == paneTranscript, false).Width(width).Height(transcriptHeight).Render(a.transcriptView(width-panePadW, transcriptHeight-panePadH))
	approvals := paneStyle(a.focus == paneApprovals, true).Width(width).Height(approvalHeight).Render(a.approvalsView(width-panePadW, approvalHeight-panePadH))
	tasks := paneStyle(a.focus == paneTasks, true).Width(width).Height(taskHeight).Render(a.tasksView(width-panePadW, taskHeight-panePadH))
	apps := paneStyle(a.focus == paneApps, true).Width(width).Height(appHeight).Render(a.appsView(width-panePadW, appHeight-panePadH))
	activity := paneStyle(a.focus == paneActivity, true).Width(width).Height(activityHeight).Render(a.activityView(width-panePadW, activityHeight-panePadH))

	return lipgloss.JoinVertical(lipgloss.Left, transcript, "", approvals, "", tasks, "", apps, "", activity)
}

func (a App) sessionMainWideView(width int, height int) string {
	leftWidth := maxInt((width*5)/8, 48)
	if leftWidth > width-32 {
		leftWidth = width - 32
	}
	rightWidth := maxInt(width-leftWidth-2, 30)

	approvalCount := len(a.state.Approvals)
	taskCount := len(a.state.Tasks)
	appCount := len(a.state.Apps)
	activityCount := len(a.state.Activity)

	approvalMin := paneMinHeight(approvalCount)
	taskMin := paneMinHeight(taskCount)
	appMin := paneMinHeight(appCount)
	activityMin := paneMinHeight(activityCount)

	totalMin := approvalMin + taskMin + appMin + activityMin + 3
	remaining := maxInt(height-totalMin, 0)

	nonEmpty := 0
	for _, c := range []int{approvalCount, taskCount, appCount, activityCount} {
		if c > 0 {
			nonEmpty++
		}
	}
	extra := 0
	if nonEmpty > 0 {
		extra = remaining / nonEmpty
	}

	approvalsHeight := approvalMin
	if approvalCount > 0 {
		approvalsHeight += extra
	}
	tasksHeight := taskMin
	if taskCount > 0 {
		tasksHeight += extra
	}
	appsHeight := appMin
	if appCount > 0 {
		appsHeight += extra
	}
	activityHeight := maxInt(height-approvalsHeight-tasksHeight-appsHeight-3, activityMin)

	transcript := paneStyle(a.focus == paneTranscript, false).Width(leftWidth).Height(height).Render(a.transcriptView(leftWidth-panePadW, height-panePadH))
	approvals := paneStyle(a.focus == paneApprovals, true).Width(rightWidth).Height(approvalsHeight).Render(a.approvalsView(rightWidth-panePadW, approvalsHeight-panePadH))
	tasks := paneStyle(a.focus == paneTasks, true).Width(rightWidth).Height(tasksHeight).Render(a.tasksView(rightWidth-panePadW, tasksHeight-panePadH))
	apps := paneStyle(a.focus == paneApps, true).Width(rightWidth).Height(appsHeight).Render(a.appsView(rightWidth-panePadW, appsHeight-panePadH))
	activity := paneStyle(a.focus == paneActivity, true).Width(rightWidth).Height(activityHeight).Render(a.activityView(rightWidth-panePadW, activityHeight-panePadH))
	right := lipgloss.JoinVertical(lipgloss.Left, approvals, "", tasks, "", apps, "", activity)

	return lipgloss.JoinHorizontal(lipgloss.Top, transcript, "  ", right)
}

func (a App) transcriptView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Transcript", a.focus == paneTranscript, fmt.Sprintf("%d messages", len(a.state.Transcript))))
	lines = append(lines, "")

	if len(a.state.Transcript) == 0 {
		lines = append(lines, ghostTextStyle.Render("No messages yet."))
		return strings.Join(lines, "\n")
	}

	availableHeight := maxInt(height-2, 1)
	entryHeights := make([]int, len(a.state.Transcript))
	totalEntryHeight := 0
	for index := range a.state.Transcript {
		entryHeights[index] = transcriptEntryHeight(a.state.Transcript[index], width)
		totalEntryHeight += entryHeights[index]
	}

	displayHeight := availableHeight
	if totalEntryHeight > availableHeight {
		displayHeight = maxInt(availableHeight-1, 1)
	}

	start, end := windowBoundsByHeights(entryHeights, a.transcriptCursor, displayHeight)
	for index := start; index < end; index++ {
		entry := a.state.Transcript[index]
		selected := index == a.transcriptCursor
		lines = append(lines, renderTranscriptEntry(entry, selected, width))
	}

	if indicator := scrollIndicator(start, end, len(a.state.Transcript)); indicator != "" {
		lines = append(lines, indicator)
	}

	return strings.Join(lines, "\n")
}

func (a App) approvalsView(width int, height int) string {
	pendingCount := 0
	for _, approval := range a.state.Approvals {
		if approval.Status == "pending" {
			pendingCount++
		}
	}

	var lines []string
	lines = append(lines, paneHeader("Approvals", a.focus == paneApprovals, fmt.Sprintf("%d pending", pendingCount)))
	lines = append(lines, "")

	if len(a.state.Approvals) == 0 {
		lines = append(lines, ghostTextStyle.Render("No approval gates right now."))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	if len(a.state.Approvals) > visible {
		visible = maxInt((height-3)/2, 1)
	}

	start, end := windowBounds(len(a.state.Approvals), a.approvalCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Approvals[index]
		selected := index == a.approvalCursor
		lines = append(lines, renderApprovalEntry(entry, selected, width))
	}

	if indicator := scrollIndicator(start, end, len(a.state.Approvals)); indicator != "" {
		lines = append(lines, indicator)
	}

	return strings.Join(lines, "\n")
}

func (a App) tasksView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Tasks", a.focus == paneTasks, fmt.Sprintf("%d tracked", len(a.state.Tasks))))
	lines = append(lines, "")

	if len(a.state.Tasks) == 0 {
		lines = append(lines, ghostTextStyle.Render("No async tasks tracked yet."))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	if len(a.state.Tasks) > visible {
		visible = maxInt((height-3)/2, 1)
	}

	start, end := windowBounds(len(a.state.Tasks), a.taskCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Tasks[index]
		selected := index == a.taskCursor
		lines = append(lines, renderTaskEntry(entry, selected, width))
	}

	if indicator := scrollIndicator(start, end, len(a.state.Tasks)); indicator != "" {
		lines = append(lines, indicator)
	}

	return strings.Join(lines, "\n")
}

func (a App) appsView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Apps", a.focus == paneApps, fmt.Sprintf("%d tracked", len(a.state.Apps))))
	lines = append(lines, "")

	if len(a.state.Apps) == 0 {
		lines = append(lines, ghostTextStyle.Render("No external apps discovered."))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	if len(a.state.Apps) > visible {
		visible = maxInt((height-3)/2, 1)
	}

	start, end := windowBounds(len(a.state.Apps), a.appCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Apps[index]
		selected := index == a.appCursor
		lines = append(lines, renderAppEntry(entry, selected, width))
	}

	if indicator := scrollIndicator(start, end, len(a.state.Apps)); indicator != "" {
		lines = append(lines, indicator)
	}

	return strings.Join(lines, "\n")
}

func (a App) activityView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Activity", a.focus == paneActivity, fmt.Sprintf("%d events", len(a.state.Activity))))
	lines = append(lines, "")

	if len(a.state.Activity) == 0 {
		lines = append(lines, ghostTextStyle.Render("No activity yet."))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	if len(a.state.Activity) > visible {
		visible = maxInt((height-3)/2, 1)
	}

	start, end := windowBounds(len(a.state.Activity), a.activityCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Activity[index]
		selected := index == a.activityCursor
		lines = append(lines, renderActivityEntry(entry, selected, width))
	}

	if indicator := scrollIndicator(start, end, len(a.state.Activity)); indicator != "" {
		lines = append(lines, indicator)
	}

	return strings.Join(lines, "\n")
}

func (a App) composerView(width int) string {
	var lines []string
	lines = append(lines, paneHeader("Composer", a.focus == paneComposer, "send into the live session"))
	lines = append(lines, "")
	if a.state.CanSendMessage {
		lines = append(lines, a.input.View())
	} else {
		lines = append(lines, mutedStyle.Render(a.state.LlmMessage))
	}
	lines = append(lines, "")
	lines = append(lines, mutedStyle.Render(a.sessionHelp()))
	return lipgloss.NewStyle().Width(width).Render(strings.Join(lines, "\n"))
}

func (a App) rejectPromptView(width int) string {
	approval := a.selectedApprovalByID(a.rejectApprovalID)
	title := paneHeader("Reject Approval", true, "optional reason")
	reason := "The selected approval is no longer visible."
	if approval != nil {
		reason = approval.Reason
	}
	modalWidth := width
	if modalWidth > 60 {
		modalWidth = 60
	}
	if modalWidth < 36 {
		modalWidth = 36
	}

	content := strings.Join([]string{
		title,
		"",
		mutedStyle.Render(truncate(compact(reason), modalWidth-8)),
		"",
		a.rejectInput.View(),
		"",
		helpStyle.Render(a.sessionHelp()),
	}, "\n")

	return modalStyle(modalWidth).Render(content)
}

func (a App) profileView() string {
	width := a.width
	if width == 0 {
		width = 120
	}
	height := a.height
	if height == 0 {
		height = 36
	}

	bodyWidth := width - 4
	if bodyWidth < 1 {
		bodyWidth = 1
	}
	bodyHeight := height - 2
	if bodyHeight < 1 {
		bodyHeight = 1
	}

	title := a.state.SessionTitle
	if title == "" {
		title = "Model Settings"
	}

	var lines []string
	lines = append(lines, accentTitleStyle.Render(title))
	meta := make([]string, 0, 4)
	if a.state.SessionStatus != "" {
		meta = append(meta, renderMetaPair("session", strings.ToUpper(a.state.SessionStatus), a.state.SessionStatus))
	}
	if a.state.LlmStatus != "" {
		meta = append(meta, renderMetaPair("llm", strings.ToUpper(strings.ReplaceAll(a.state.LlmStatus, "_", " ")), a.state.LlmStatus))
	}
	if a.state.SecureStoreStatus != "" {
		meta = append(meta, renderMetaPair("store", strings.ToUpper(strings.ReplaceAll(a.state.SecureStoreStatus, "_", " ")), a.state.SecureStoreStatus))
	}
	if len(meta) > 0 {
		lines = append(lines, strings.Join(meta, "   "))
	}
	if a.state.LlmMessage != "" {
		lines = append(lines, mutedStyle.Render(a.state.LlmMessage))
	}
	if a.sessionErr != "" {
		lines = append(lines, dangerStyle.Render(a.sessionErr))
	}

	header := lipgloss.NewStyle().Width(bodyWidth).Render(strings.Join(lines, "\n"))
	headerHeight := blockHeight(header)
	panelHeight := maxInt(bodyHeight-headerHeight-4, 16)

	if bodyWidth < 108 {
		listHeight := maxInt(panelHeight/2, 8)
		formHeight := maxInt(panelHeight-listHeight-1, 10)
		list := paneStyle(a.profileFocus == profileList, true).Width(bodyWidth).Height(listHeight).Render(a.profileListView(bodyWidth-panePadW, listHeight-panePadH))
		form := paneStyle(a.profileFocus == profileForm, false).Width(bodyWidth).Height(formHeight).Render(a.profileFormView(bodyWidth-panePadW, formHeight-panePadH))
		content := lipgloss.JoinVertical(lipgloss.Left, header, "", list, "", form, "", helpStyle.Render(a.profileHelp()))
		return appStyle.Render(content)
	}

	leftWidth := maxInt((bodyWidth*2)/5, 34)
	if leftWidth > bodyWidth-36 {
		leftWidth = bodyWidth - 36
	}
	rightWidth := maxInt(bodyWidth-leftWidth-2, 32)
	list := paneStyle(a.profileFocus == profileList, true).Width(leftWidth).Height(panelHeight).Render(a.profileListView(leftWidth-panePadW, panelHeight-panePadH))
	form := paneStyle(a.profileFocus == profileForm, false).Width(rightWidth).Height(panelHeight).Render(a.profileFormView(rightWidth-panePadW, panelHeight-panePadH))
	content := lipgloss.JoinVertical(
		lipgloss.Left,
		header,
		"",
		lipgloss.JoinHorizontal(lipgloss.Top, list, "  ", form),
		"",
		helpStyle.Render(a.profileHelp()),
	)
	return appStyle.Render(content)
}

func (a App) settingsView() string {
	width := a.width
	if width == 0 {
		width = 120
	}
	height := a.height
	if height == 0 {
		height = 36
	}

	bodyWidth := width - 4
	if bodyWidth < 1 {
		bodyWidth = 1
	}
	bodyHeight := height - 2
	if bodyHeight < 1 {
		bodyHeight = 1
	}

	headerLines := []string{
		accentTitleStyle.Render("TUI Settings"),
		strings.Join([]string{
			renderMetaPair("leader", a.tuiSettings.Keybinds.Leader, ""),
			renderMetaPair("scope", "HOME CONFIG", ""),
		}, "   "),
	}
	if a.sessionErr != "" {
		headerLines = append(headerLines, warningStyle.Render(a.sessionErr))
	}
	header := lipgloss.NewStyle().Width(bodyWidth).Render(strings.Join(headerLines, "\n"))
	headerHeight := blockHeight(header)
	panelHeight := maxInt(bodyHeight-headerHeight-3, 10)
	panel := paneStyle(true, false).Width(bodyWidth).Height(panelHeight).Render(a.settingsPanelView(bodyWidth-panePadW, panelHeight-panePadH))
	content := lipgloss.JoinVertical(lipgloss.Left, header, "", panel, "", helpStyle.Render(a.settingsHelp()))
	return appStyle.Render(content)
}

func (a App) profileListView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Profiles", a.profileFocus == profileList, fmt.Sprintf("%d available", len(a.state.Profiles))))
	lines = append(lines, "")

	if len(a.state.Profiles) == 0 {
		lines = append(lines, ghostTextStyle.Render(fmt.Sprintf("No profiles yet. Press %s to create the first one.", a.leaderBinding("n"))))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	start, end := windowBounds(len(a.state.Profiles), a.profileCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Profiles[index]
		selected := index == a.profileCursor
		lines = append(lines, renderProfileEntry(entry, selected, width))
	}

	return strings.Join(lines, "\n")
}

func (a App) profileFormView(width int, _ int) string {
	mode := "new profile"
	if a.editingProfileID != "" {
		mode = "editing selected profile"
	} else if profile := a.selectedProfile(); profile != nil && profile.Origin == "environment" {
		mode = "saving environment profile as managed"
	}

	labelWidth := 10
	fieldWidth := width - labelWidth - 2
	if fieldWidth < 12 {
		fieldWidth = 12
	}
	a.profileLabelInput.Width = fieldWidth
	a.profileProviderInput.Width = fieldWidth
	a.profileModelInput.Width = fieldWidth
	a.profileBaseURLInput.Width = fieldWidth
	a.profileAPIKeyInput.Width = fieldWidth

	rows := []string{
		paneHeader("Profile Form", a.profileFocus == profileForm, mode),
		"",
		renderInputRow("Label", a.profileLabelInput, a.profileFocus == profileForm && a.profileFieldFocus == 0, a.profileFieldEditing && a.profileFieldFocus == 0, width),
		renderInputRow("Provider", a.profileProviderInput, a.profileFocus == profileForm && a.profileFieldFocus == 1, a.profileFieldEditing && a.profileFieldFocus == 1, width),
		renderInputRow("Model", a.profileModelInput, a.profileFocus == profileForm && a.profileFieldFocus == 2, a.profileFieldEditing && a.profileFieldFocus == 2, width),
		renderInputRow("Base URL", a.profileBaseURLInput, a.profileFocus == profileForm && a.profileFieldFocus == 3, a.profileFieldEditing && a.profileFieldFocus == 3, width),
		renderInputRow("API key", a.profileAPIKeyInput, a.profileFocus == profileForm && a.profileFieldFocus == 4, a.profileFieldEditing && a.profileFieldFocus == 4, width),
		"",
		mutedStyle.Render("Saving with a non-empty API key stores it securely when the machine supports it. Environment-backed profiles are copied into managed profiles when saved here."),
	}

	return lipgloss.NewStyle().Width(width).Render(strings.Join(rows, "\n"))
}

func (a App) settingsPanelView(width int, _ int) string {
	status := mutedStyle.Render("press enter to capture a new leader")
	if a.settingsCapturing {
		status = keyStyle.Render("capturing next key")
	}

	rows := []string{
		paneHeader("Keybinds", true, "home config"),
		"",
		renderSettingRow("Leader key", a.tuiSettings.Keybinds.Leader, status, width),
		"",
		mutedStyle.Render("Saved to ~/.sloppy/config.yaml. Workspace config can still override this value."),
	}

	return lipgloss.NewStyle().Width(width).Render(strings.Join(rows, "\n"))
}

func (a App) sessionBodyWidth() int {
	width := a.width
	if width == 0 {
		width = 120
	}
	bodyWidth := width - 4
	if bodyWidth < 1 {
		bodyWidth = 1
	}
	return bodyWidth
}
