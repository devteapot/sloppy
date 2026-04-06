package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	slop "github.com/devteapot/slop/packages/go/slop-ai"
	"github.com/devteapot/sloppy/apps/tui/provider"
	"github.com/devteapot/sloppy/apps/tui/session"
)

type discoveryMsg struct {
	providers []provider.Descriptor
	err       error
}

type connectMsg struct {
	err error
}

type sessionUpdatedMsg struct{}

type sessionStreamClosedMsg struct{}

type sendMessageMsg struct {
	err error
}

type sessionActionMsg struct {
	err error
}

type paneFocus int

type profilePaneFocus int

const (
	paneTranscript paneFocus = iota
	paneApprovals
	paneTasks
	paneActivity
	paneComposer
)

const (
	profileList profilePaneFocus = iota
	profileForm
)

type App struct {
	width  int
	height int

	address   string
	mode      string
	cursor    int
	providers []provider.Descriptor
	err       error

	manager       *session.Manager
	state         session.ViewState
	input         textinput.Model
	sessionScreen string

	rejectInput      textinput.Model
	rejectApprovalID string
	sessionErr       string
	focus            paneFocus

	profileFocus         profilePaneFocus
	profileFieldFocus    int
	profileCursor        int
	editingProfileID     string
	profileLabelInput    textinput.Model
	profileProviderInput textinput.Model
	profileModelInput    textinput.Model
	profileBaseURLInput  textinput.Model
	profileAPIKeyInput   textinput.Model

	transcriptCursor int
	approvalCursor   int
	taskCursor       int
	activityCursor   int
}

func NewApp(address string) App {
	input := newCodeInput("Ask the agent...")
	input.Width = 72
	input.Focus()

	rejectInput := newCodeInput("Optional rejection reason...")
	rejectInput.CharLimit = 512
	rejectInput.Width = 48
	rejectInput.Blur()

	profileLabelInput := newCodeInput("Profile label")
	profileProviderInput := newCodeInput("Provider: anthropic, openai, openrouter, ollama, gemini")
	profileModelInput := newCodeInput("Model")
	profileBaseURLInput := newCodeInput("Optional base URL")
	profileAPIKeyInput := newCodeInput("Optional API key")
	profileAPIKeyInput.EchoMode = textinput.EchoPassword
	profileAPIKeyInput.EchoCharacter = '*'

	profileLabelInput.Blur()
	profileProviderInput.Blur()
	profileModelInput.Blur()
	profileBaseURLInput.Blur()
	profileAPIKeyInput.Blur()

	mode := "discovery"
	if address != "" {
		mode = "session"
	}

	return App{
		address:              address,
		mode:                 mode,
		manager:              session.NewManager(),
		input:                input,
		rejectInput:          rejectInput,
		focus:                paneComposer,
		sessionScreen:        "main",
		profileFocus:         profileList,
		profileLabelInput:    profileLabelInput,
		profileProviderInput: profileProviderInput,
		profileModelInput:    profileModelInput,
		profileBaseURLInput:  profileBaseURLInput,
		profileAPIKeyInput:   profileAPIKeyInput,
	}
}

func (a App) Init() tea.Cmd {
	if a.address != "" {
		return connectCmd(a.manager, a.address)
	}

	return discoverCmd()
}

func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch message := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = message.Width
		a.height = message.Height
		return a, nil

	case discoveryMsg:
		a.providers = message.providers
		a.err = message.err
		if a.cursor >= len(a.providers) {
			a.cursor = clampIndex(a.cursor, len(a.providers))
		}
		return a, nil

	case connectMsg:
		a.err = message.err
		if message.err != nil {
			return a, nil
		}

		a.mode = "session"
		a.sessionErr = ""
		a.focus = paneComposer
		a.rejectApprovalID = ""
		a = a.applyViewStateFromManager()
		return a, waitForSessionUpdate(a.manager.Updates())

	case sessionUpdatedMsg:
		if a.mode != "session" {
			return a, nil
		}

		a = a.applyViewStateFromManager()
		return a, waitForSessionUpdate(a.manager.Updates())

	case sessionStreamClosedMsg:
		if a.mode != "session" {
			return a, nil
		}

		a = a.applyViewStateFromManager()
		return a, nil

	case sendMessageMsg:
		if message.err != nil {
			a.sessionErr = message.err.Error()
			return a, nil
		}

		a.sessionErr = ""
		a.input.SetValue("")
		return a, nil

	case sessionActionMsg:
		if message.err != nil {
			a.sessionErr = message.err.Error()
		} else {
			a.sessionErr = ""
			a.profileAPIKeyInput.SetValue("")
		}
		return a, nil

	case tea.KeyMsg:
		if a.mode == "discovery" {
			return a.updateDiscovery(message)
		}
		return a.updateSession(message)
	}

	return a, nil
}

func (a App) View() string {
	if a.mode == "discovery" {
		return a.discoveryView()
	}
	if a.sessionScreen == "profiles" {
		return a.profileView()
	}

	return a.sessionView()
}

func (a App) updateDiscovery(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch message.String() {
	case "ctrl+c", "q":
		return a, tea.Quit
	case "r":
		return a, discoverCmd()
	case "up", "k":
		if a.cursor > 0 {
			a.cursor--
		}
	case "down", "j":
		if a.cursor < len(a.providers)-1 {
			a.cursor++
		}
	case "enter":
		if len(a.providers) == 0 {
			return a, nil
		}
		a.address = a.providers[a.cursor].Address()
		return a, connectCmd(a.manager, a.address)
	}

	return a, nil
}

func (a App) updateSession(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.rejectPromptOpen() {
		return a.updateRejectPrompt(message)
	}
	if a.sessionScreen == "profiles" {
		return a.updateProfiles(message)
	}
	if a.focus == paneComposer {
		switch message.String() {
		case "ctrl+c":
			return a, tea.Quit
		case "esc":
			a.manager.Disconnect()
			a.state = session.ViewState{}
			a.address = ""
			a.mode = "discovery"
			a.sessionErr = ""
			a.rejectApprovalID = ""
			a.focus = paneComposer
			a.sessionScreen = "main"
			a.syncInputs()
			return a, discoverCmd()
		case "tab":
			a.focus = nextPane(a.focus)
			a.syncInputs()
			return a, nil
		case "shift+tab":
			a.focus = previousPane(a.focus)
			a.syncInputs()
			return a, nil
		case "enter":
			text := strings.TrimSpace(a.input.Value())
			if text == "" {
				return a, nil
			}
			return a, sendMessageCmd(a.manager, text)
		}

		var cmd tea.Cmd
		a.input, cmd = a.input.Update(message)
		return a, cmd
	}

	switch message.String() {
	case "ctrl+c", "q":
		return a, tea.Quit
	case "s":
		a.sessionScreen = "profiles"
		a.profileFocus = profileList
		a.loadSelectedProfileIntoForm()
		a.syncInputs()
		return a, nil
	case "esc":
		a.manager.Disconnect()
		a.state = session.ViewState{}
		a.address = ""
		a.mode = "discovery"
		a.sessionErr = ""
		a.rejectApprovalID = ""
		a.focus = paneComposer
		a.sessionScreen = "main"
		a.syncInputs()
		return a, discoverCmd()
	case "tab", "right":
		a.focus = nextPane(a.focus)
		a.syncInputs()
		return a, nil
	case "shift+tab", "left":
		a.focus = previousPane(a.focus)
		a.syncInputs()
		return a, nil
	case "i":
		a.focus = paneComposer
		a.syncInputs()
		return a, nil
	case "up", "k":
		if a.focus != paneComposer {
			a.moveSelection(-1)
			return a, nil
		}
	case "down", "j":
		if a.focus != paneComposer {
			a.moveSelection(1)
			return a, nil
		}
	case "a":
		if approval := a.selectedApproval(); approval != nil && approval.CanApprove && a.focus == paneApprovals {
			return a, approveApprovalCmd(a.manager, approval.ID)
		}
	case "r":
		if approval := a.selectedApproval(); approval != nil && approval.CanReject && a.focus == paneApprovals {
			a.rejectApprovalID = approval.ID
			a.rejectInput.SetValue("")
			a.syncInputs()
			return a, nil
		}
	case "c":
		if task := a.selectedTask(); task != nil && task.CanCancel && a.focus == paneTasks {
			return a, cancelTaskCmd(a.manager, task.ID)
		}
	case "t":
		if a.state.CanCancelTurn && a.focus != paneComposer {
			return a, cancelTurnCmd(a.manager)
		}
	case "enter":
		switch a.focus {
		case paneApprovals:
			if approval := a.selectedApproval(); approval != nil && approval.CanApprove {
				return a, approveApprovalCmd(a.manager, approval.ID)
			}
		case paneTasks:
			if task := a.selectedTask(); task != nil && task.CanCancel {
				return a, cancelTaskCmd(a.manager, task.ID)
			}
		}
	}

	return a, nil
}

func (a App) updateRejectPrompt(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch message.String() {
	case "ctrl+c":
		return a, tea.Quit
	case "esc":
		a.rejectApprovalID = ""
		a.rejectInput.SetValue("")
		a.syncInputs()
		return a, nil
	case "enter":
		approvalID := a.rejectApprovalID
		reason := strings.TrimSpace(a.rejectInput.Value())
		a.rejectApprovalID = ""
		a.rejectInput.SetValue("")
		a.syncInputs()
		if approvalID == "" {
			return a, nil
		}
		return a, rejectApprovalCmd(a.manager, approvalID, reason)
	}

	var cmd tea.Cmd
	a.rejectInput, cmd = a.rejectInput.Update(message)
	return a, cmd
}

func (a App) updateProfiles(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.profileFocus == profileForm {
		switch message.String() {
		case "ctrl+c":
			return a, tea.Quit
		case "esc":
			if a.state.CanSendMessage {
				a.sessionScreen = "main"
				a.focus = paneComposer
			} else {
				a.profileFocus = profileList
			}
			a.syncInputs()
			return a, nil
		case "tab":
			a.profileFieldFocus = (a.profileFieldFocus + 1) % 5
			a.syncInputs()
			return a, nil
		case "shift+tab":
			a.profileFieldFocus = (a.profileFieldFocus + 4) % 5
			a.syncInputs()
			return a, nil
		case "enter":
			provider := strings.TrimSpace(a.profileProviderInput.Value())
			model := strings.TrimSpace(a.profileModelInput.Value())
			if provider == "" || model == "" {
				a.sessionErr = "Provider and model are required."
				return a, nil
			}

			params := slop.Params{
				"provider": provider,
				"model":    model,
			}
			if trimmed := strings.TrimSpace(a.profileLabelInput.Value()); trimmed != "" {
				params["label"] = trimmed
			}
			if trimmed := strings.TrimSpace(a.profileBaseURLInput.Value()); trimmed != "" {
				params["base_url"] = trimmed
			}
			if trimmed := strings.TrimSpace(a.profileAPIKeyInput.Value()); trimmed != "" {
				params["api_key"] = trimmed
			}
			if a.editingProfileID != "" {
				params["profile_id"] = a.editingProfileID
			}
			return a, saveProfileCmd(a.manager, params)
		}

		var cmd tea.Cmd
		switch a.profileFieldFocus {
		case 0:
			a.profileLabelInput, cmd = a.profileLabelInput.Update(message)
		case 1:
			a.profileProviderInput, cmd = a.profileProviderInput.Update(message)
		case 2:
			a.profileModelInput, cmd = a.profileModelInput.Update(message)
		case 3:
			a.profileBaseURLInput, cmd = a.profileBaseURLInput.Update(message)
		default:
			a.profileAPIKeyInput, cmd = a.profileAPIKeyInput.Update(message)
		}

		return a, cmd
	}

	switch message.String() {
	case "ctrl+c", "q":
		return a, tea.Quit
	case "s", "esc":
		if a.state.CanSendMessage {
			a.sessionScreen = "main"
			a.focus = paneComposer
			a.syncInputs()
		}
		return a, nil
	case "left", "h":
		a.profileFocus = profileList
		a.syncInputs()
		return a, nil
	case "right", "l", "i":
		a.profileFocus = profileForm
		if a.editingProfileID == "" {
			a.loadSelectedProfileIntoForm()
		}
		a.syncInputs()
		return a, nil
	}

	if a.profileFocus == profileList {
		switch message.String() {
		case "up", "k":
			if a.profileCursor > 0 {
				a.profileCursor--
			}
			return a, nil
		case "down", "j":
			if a.profileCursor < len(a.state.Profiles)-1 {
				a.profileCursor++
			}
			return a, nil
		case "enter":
			a.profileFocus = profileForm
			a.loadSelectedProfileIntoForm()
			a.syncInputs()
			return a, nil
		case "n":
			a.startNewProfileForm()
			a.profileFocus = profileForm
			a.syncInputs()
			return a, nil
		case "f":
			if profile := a.selectedProfile(); profile != nil {
				return a, setDefaultProfileCmd(a.manager, profile.ID)
			}
		case "d":
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteProfile {
				return a, deleteProfileCmd(a.manager, profile.ID)
			}
		case "x":
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteAPIKey {
				return a, deleteAPIKeyCmd(a.manager, profile.ID)
			}
		}

		return a, nil
	}

	return a, nil
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
		list := paneStyle(a.profileFocus == profileList, true).Width(bodyWidth).Height(listHeight).Render(a.profileListView(bodyWidth-4, listHeight-2))
		form := paneStyle(a.profileFocus == profileForm, false).Width(bodyWidth).Height(formHeight).Render(a.profileFormView(bodyWidth-4, formHeight-2))
		content := lipgloss.JoinVertical(lipgloss.Left, header, "", list, "", form, "", helpStyle.Render(a.profileHelp()))
		return appStyle.Render(content)
	}

	leftWidth := maxInt((bodyWidth*2)/5, 34)
	if leftWidth > bodyWidth-36 {
		leftWidth = bodyWidth - 36
	}
	rightWidth := maxInt(bodyWidth-leftWidth-2, 32)
	list := paneStyle(a.profileFocus == profileList, true).Width(leftWidth).Height(panelHeight).Render(a.profileListView(leftWidth-4, panelHeight-2))
	form := paneStyle(a.profileFocus == profileForm, false).Width(rightWidth).Height(panelHeight).Render(a.profileFormView(rightWidth-4, panelHeight-2))
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

func (a App) profileListView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Profiles", a.profileFocus == profileList, fmt.Sprintf("%d available", len(a.state.Profiles))))
	lines = append(lines, "")

	if len(a.state.Profiles) == 0 {
		lines = append(lines, ghostTextStyle.Render("No profiles yet. Press n to create the first one."))
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
		renderInputRow("Label", a.profileLabelInput),
		renderInputRow("Provider", a.profileProviderInput),
		renderInputRow("Model", a.profileModelInput),
		renderInputRow("Base URL", a.profileBaseURLInput),
		renderInputRow("API key", a.profileAPIKeyInput),
		"",
		mutedStyle.Render("Saving with a non-empty API key stores it securely when the machine supports it. Environment-backed profiles are copied into managed profiles when saved here."),
	}

	return lipgloss.NewStyle().Width(width).Render(strings.Join(rows, "\n"))
}

func renderInputRow(label string, input textinput.Model) string {
	return fmt.Sprintf("%s %s", lipgloss.NewStyle().Width(10).Render(metaLabelStyle.Render(strings.ToUpper(label))), input.View())
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

func (a App) discoveryView() string {
	var lines []string
	lines = append(lines, accentTitleStyle.Render("Sloppy TUI"))
	lines = append(lines, mutedStyle.Render("Attach to a running agent-session provider"))
	lines = append(lines, "")

	if len(a.providers) == 0 {
		lines = append(lines, mutedStyle.Render("No session providers found. Start `bun run session:serve` first."))
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

	lines = append(lines, "")
	lines = append(lines, helpStyle.Render("enter connect  r refresh  q quit"))
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
	composerHeight := 8
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
		meta = append(meta, fmt.Sprintf("%s %s", metaLabelStyle.Render("TURN ACTION"), keyStyle.Render("T cancel")))
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
		transcriptHeight := maxInt(height/2, 8)
		railHeight := maxInt(height-transcriptHeight-3, 12)
		approvalHeight := maxInt(railHeight/4, 6)
		taskHeight := maxInt(railHeight/4, 6)
		activityHeight := maxInt(railHeight-approvalHeight-taskHeight-2, 8)

		transcript := paneStyle(a.focus == paneTranscript, false).Width(width).Height(transcriptHeight).Render(a.transcriptView(width-4, transcriptHeight-2))
		approvals := paneStyle(a.focus == paneApprovals, true).Width(width).Height(approvalHeight).Render(a.approvalsView(width-4, approvalHeight-2))
		tasks := paneStyle(a.focus == paneTasks, true).Width(width).Height(taskHeight).Render(a.tasksView(width-4, taskHeight-2))
		activity := paneStyle(a.focus == paneActivity, true).Width(width).Height(activityHeight).Render(a.activityView(width-4, activityHeight-2))

		return lipgloss.JoinVertical(lipgloss.Left, transcript, "", approvals, "", tasks, "", activity)
	}

	leftWidth := maxInt((width*5)/8, 48)
	if leftWidth > width-32 {
		leftWidth = width - 32
	}
	rightWidth := maxInt(width-leftWidth-2, 30)
	approvalsHeight := maxInt(height/4, 7)
	tasksHeight := maxInt(height/4, 7)
	activityHeight := maxInt(height-approvalsHeight-tasksHeight-2, 8)

	transcript := paneStyle(a.focus == paneTranscript, false).Width(leftWidth).Height(height).Render(a.transcriptView(leftWidth-4, height-2))
	approvals := paneStyle(a.focus == paneApprovals, true).Width(rightWidth).Height(approvalsHeight).Render(a.approvalsView(rightWidth-4, approvalsHeight-2))
	tasks := paneStyle(a.focus == paneTasks, true).Width(rightWidth).Height(tasksHeight).Render(a.tasksView(rightWidth-4, tasksHeight-2))
	activity := paneStyle(a.focus == paneActivity, true).Width(rightWidth).Height(activityHeight).Render(a.activityView(rightWidth-4, activityHeight-2))
	right := lipgloss.JoinVertical(lipgloss.Left, approvals, "", tasks, "", activity)

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

	visible := maxInt((height-2)/2, 1)
	start, end := windowBounds(len(a.state.Transcript), a.transcriptCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Transcript[index]
		selected := index == a.transcriptCursor
		lines = append(lines, renderTranscriptEntry(entry, selected, width))
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
	start, end := windowBounds(len(a.state.Approvals), a.approvalCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Approvals[index]
		selected := index == a.approvalCursor
		lines = append(lines, renderApprovalEntry(entry, selected, width))
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
	start, end := windowBounds(len(a.state.Tasks), a.taskCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Tasks[index]
		selected := index == a.taskCursor
		lines = append(lines, renderTaskEntry(entry, selected, width))
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
	start, end := windowBounds(len(a.state.Activity), a.activityCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Activity[index]
		selected := index == a.activityCursor
		lines = append(lines, renderActivityEntry(entry, selected, width))
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
		mutedStyle.Render(truncate(compact(reason), modalWidth-4)),
		"",
		a.rejectInput.View(),
		"",
		helpStyle.Render("enter reject  esc cancel"),
	}, "\n")

	return modalStyle(modalWidth).Render(content)
}

func (a App) applyViewStateFromManager() App {
	tree, err := a.manager.Snapshot()
	return a.applyViewState(session.BuildView(tree, err))
}

func (a App) applyViewState(next session.ViewState) App {
	previous := a.state
	a.state = next

	a.transcriptCursor = preserveCursor(len(previous.Transcript), len(next.Transcript), a.transcriptCursor)
	a.approvalCursor = preserveCursor(len(previous.Approvals), len(next.Approvals), a.approvalCursor)
	a.taskCursor = preserveCursor(len(previous.Tasks), len(next.Tasks), a.taskCursor)
	a.activityCursor = preserveCursor(len(previous.Activity), len(next.Activity), a.activityCursor)
	a.profileCursor = preserveCursor(len(previous.Profiles), len(next.Profiles), a.profileCursor)

	if !hasPendingApprovals(previous.Approvals) && hasPendingApprovals(next.Approvals) && !a.rejectPromptOpen() {
		if pendingIndex := firstPendingApprovalIndex(next.Approvals); pendingIndex >= 0 {
			a.approvalCursor = pendingIndex
		}
		if strings.TrimSpace(a.input.Value()) == "" || a.focus != paneComposer {
			a.focus = paneApprovals
		}
	}

	if !next.CanSendMessage || next.LlmStatus != "ready" {
		a.sessionScreen = "profiles"
	}
	if a.sessionScreen == "profiles" {
		if a.editingProfileID == "" {
			a.loadSelectedProfileIntoForm()
		} else if profile := a.selectedProfileByID(a.editingProfileID); profile != nil {
			a.profileLabelInput.SetValue(profile.Label)
			a.profileProviderInput.SetValue(profile.Provider)
			a.profileModelInput.SetValue(profile.Model)
			a.profileBaseURLInput.SetValue(profile.BaseURL)
		} else {
			a.startNewProfileForm()
		}
	}

	a.syncInputs()
	return a
}

func (a *App) syncInputs() {
	if a.rejectPromptOpen() {
		a.blurProfileInputs()
		a.rejectInput.Focus()
		a.input.Blur()
		return
	}

	a.rejectInput.Blur()
	if a.sessionScreen == "profiles" {
		a.input.Blur()
		if a.profileFocus != profileForm {
			a.blurProfileInputs()
			return
		}

		a.blurProfileInputs()
		switch a.profileFieldFocus {
		case 0:
			a.profileLabelInput.Focus()
		case 1:
			a.profileProviderInput.Focus()
		case 2:
			a.profileModelInput.Focus()
		case 3:
			a.profileBaseURLInput.Focus()
		default:
			a.profileAPIKeyInput.Focus()
		}
		return
	}

	a.blurProfileInputs()
	if a.focus == paneComposer {
		a.input.Focus()
	} else {
		a.input.Blur()
	}
}

func (a *App) blurProfileInputs() {
	a.profileLabelInput.Blur()
	a.profileProviderInput.Blur()
	a.profileModelInput.Blur()
	a.profileBaseURLInput.Blur()
	a.profileAPIKeyInput.Blur()
}

func (a *App) moveSelection(delta int) {
	switch a.focus {
	case paneTranscript:
		a.transcriptCursor = clampRange(a.transcriptCursor+delta, len(a.state.Transcript))
	case paneApprovals:
		a.approvalCursor = clampRange(a.approvalCursor+delta, len(a.state.Approvals))
	case paneTasks:
		a.taskCursor = clampRange(a.taskCursor+delta, len(a.state.Tasks))
	case paneActivity:
		a.activityCursor = clampRange(a.activityCursor+delta, len(a.state.Activity))
	}
}

func (a App) selectedApproval() *session.ApprovalEntry {
	if len(a.state.Approvals) == 0 {
		return nil
	}
	index := clampRange(a.approvalCursor, len(a.state.Approvals))
	return &a.state.Approvals[index]
}

func (a App) selectedApprovalByID(id string) *session.ApprovalEntry {
	if id == "" {
		return nil
	}
	for index := range a.state.Approvals {
		if a.state.Approvals[index].ID == id {
			return &a.state.Approvals[index]
		}
	}
	return nil
}

func (a App) selectedTask() *session.TaskEntry {
	if len(a.state.Tasks) == 0 {
		return nil
	}
	index := clampRange(a.taskCursor, len(a.state.Tasks))
	return &a.state.Tasks[index]
}

func (a App) selectedProfile() *session.LlmProfileEntry {
	if len(a.state.Profiles) == 0 {
		return nil
	}
	index := clampRange(a.profileCursor, len(a.state.Profiles))
	return &a.state.Profiles[index]
}

func (a App) selectedProfileByID(id string) *session.LlmProfileEntry {
	if id == "" {
		return nil
	}
	for index := range a.state.Profiles {
		if a.state.Profiles[index].ID == id {
			return &a.state.Profiles[index]
		}
	}
	return nil
}

func (a *App) loadSelectedProfileIntoForm() {
	if profile := a.selectedProfile(); profile != nil {
		if profile.Managed {
			a.editingProfileID = profile.ID
		} else {
			a.editingProfileID = ""
		}
		a.profileFieldFocus = 0
		label := profile.Label
		if profile.Origin == "environment" && profile.APIKeyEnv != "" {
			label = strings.TrimSuffix(label, fmt.Sprintf(" (%s)", profile.APIKeyEnv))
		}
		a.profileLabelInput.SetValue(label)
		a.profileProviderInput.SetValue(profile.Provider)
		a.profileModelInput.SetValue(profile.Model)
		a.profileBaseURLInput.SetValue(profile.BaseURL)
		a.profileAPIKeyInput.SetValue("")
		return
	}

	a.startNewProfileForm()
}

func (a *App) startNewProfileForm() {
	a.editingProfileID = ""
	a.profileFieldFocus = 0
	a.profileLabelInput.SetValue("")
	if a.state.LlmStatus == "ready" && len(a.state.Profiles) > 0 {
		if profile := a.selectedProfile(); profile != nil {
			a.profileProviderInput.SetValue(profile.Provider)
			a.profileModelInput.SetValue(profile.Model)
			a.profileBaseURLInput.SetValue(profile.BaseURL)
		} else {
			a.profileProviderInput.SetValue("")
			a.profileModelInput.SetValue("")
			a.profileBaseURLInput.SetValue("")
		}
	} else {
		a.profileProviderInput.SetValue("")
		a.profileModelInput.SetValue("")
		a.profileBaseURLInput.SetValue("")
	}
	a.profileAPIKeyInput.SetValue("")
}

func (a App) rejectPromptOpen() bool {
	return a.rejectApprovalID != ""
}

func discoverCmd() tea.Cmd {
	return func() tea.Msg {
		providers, err := provider.DiscoverSessionProviders()
		return discoveryMsg{providers: providers, err: err}
	}
}

func connectCmd(manager *session.Manager, address string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return connectMsg{err: manager.Connect(ctx, address)}
	}
}

func sendMessageCmd(manager *session.Manager, text string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return sendMessageMsg{err: manager.SendMessage(ctx, text)}
	}
}

func approveApprovalCmd(manager *session.Manager, approvalID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.ApproveApproval(ctx, approvalID)}
	}
}

func rejectApprovalCmd(manager *session.Manager, approvalID string, reason string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.RejectApproval(ctx, approvalID, reason)}
	}
}

func cancelTaskCmd(manager *session.Manager, taskID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.CancelTask(ctx, taskID)}
	}
}

func cancelTurnCmd(manager *session.Manager) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.CancelTurn(ctx)}
	}
}

func saveProfileCmd(manager *session.Manager, params slop.Params) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.Invoke(ctx, "/llm", "save_profile", params)}
	}
}

func setDefaultProfileCmd(manager *session.Manager, profileID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.Invoke(ctx, "/llm", "set_default_profile", slop.Params{"profile_id": profileID})}
	}
}

func deleteProfileCmd(manager *session.Manager, profileID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.Invoke(ctx, "/llm", "delete_profile", slop.Params{"profile_id": profileID})}
	}
}

func deleteAPIKeyCmd(manager *session.Manager, profileID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.Invoke(ctx, "/llm", "delete_api_key", slop.Params{"profile_id": profileID})}
	}
}

func waitForSessionUpdate(updates <-chan struct{}) tea.Cmd {
	return func() tea.Msg {
		if updates == nil {
			return sessionStreamClosedMsg{}
		}

		_, ok := <-updates
		if !ok {
			return sessionStreamClosedMsg{}
		}

		return sessionUpdatedMsg{}
	}
}

func renderTranscriptEntry(entry session.TranscriptEntry, selected bool, width int) string {
	title := strings.ToUpper(entry.Role)
	if entry.Author != "" && !strings.EqualFold(entry.Author, entry.Role) {
		title = fmt.Sprintf("%s · %s", title, entry.Author)
	}
	status := statusStyle(entry.State).Render(strings.ToUpper(entry.State))
	excerpt := compact(entry.Text)
	if excerpt == "" {
		excerpt = "No text content."
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
		"  " + truncate(excerpt, width-4),
	}
	return renderListItem(selected, width, lines)
}

func renderApprovalEntry(entry session.ApprovalEntry, selected bool, width int) string {
	status := statusStyle(entry.Status).Render(strings.ToUpper(strings.ReplaceAll(entry.Status, "_", " ")))
	title := fmt.Sprintf("%s:%s", entry.Provider, entry.Action)
	if entry.Dangerous {
		title = title + " !"
	}
	detail := joinNonEmpty(" | ", entry.Reason, entry.Path, entry.ParamsPreview)
	if detail == "" {
		detail = entry.Path
	}
	lines := []string{
		fmt.Sprintf("%s %s  %s", listPrefix(selected), labelStyle.Render(title), status),
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

	text := fmt.Sprintf("%s %s", marker, strings.ToUpper(title))
	if detail != "" {
		text = fmt.Sprintf("%s  %s", text, mutedStyle.Render(detail))
	}
	return headerStyle.Render(text)
}

func listPrefix(selected bool) string {
	if selected {
		return selectedAccentStyle.Render("->")
	}
	return ghostTextStyle.Render("·")
}

func statusStyle(status string) lipgloss.Style {
	switch status {
	case "active", "complete", "completed", "approved", "ok", "idle":
		return successStyle
	case "running", "streaming", "accepted", "pending", "waiting_approval":
		return keyStyle
	case "failed", "error", "rejected", "expired", "cancelled":
		return dangerStyle
	default:
		return mutedStyle
	}
}

func (a App) sessionHelp() string {
	if a.rejectPromptOpen() {
		return "enter reject  esc cancel"
	}

	switch a.focus {
	case paneComposer:
		return "tab cycle  enter send  esc back  ctrl+c quit"
	case paneApprovals:
		return "j/k move  enter or a approve  r reject  t cancel turn  s settings  i compose"
	case paneTasks:
		return "j/k move  enter or c cancel task  t cancel turn  s settings  i compose"
	default:
		return "tab cycle  j/k move  t cancel turn  s settings  i compose  esc back"
	}
}

func (a App) profileHelp() string {
	if a.profileFocus == profileList {
		if a.state.CanSendMessage {
			return "j/k move  enter copy/edit  n new  f default  d delete managed  x drop stored key  s back"
		}
		return "j/k move  enter copy/edit  n new  f default  d delete managed  x drop stored key  q quit"
	}

	if a.state.CanSendMessage {
		return "tab next field  shift+tab prev  enter save  esc back"
	}
	return "tab next field  shift+tab prev  enter save  esc list  ctrl+c quit"
}

func newCodeInput(placeholder string) textinput.Model {
	input := textinput.New()
	input.Placeholder = placeholder
	input.CharLimit = 4096
	input.Prompt = "> "
	input.PromptStyle = keyStyle
	input.TextStyle = codeStyle
	input.PlaceholderStyle = mutedStyle
	input.Cursor.Style = keyStyle
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
