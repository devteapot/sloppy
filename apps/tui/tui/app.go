package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
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
	paneApps
	paneActivity
	paneComposer
)

const (
	profileList profilePaneFocus = iota
	profileForm
)

const (
	sessionScreenMain     = "main"
	sessionScreenProfiles = "profiles"
	sessionScreenSettings = "settings"
)

type App struct {
	width  int
	height int

	cwd string

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
	leaderPending    bool
	focus            paneFocus
	lastMainFocus    paneFocus
	rejectEditing    bool

	profileFocus         profilePaneFocus
	profileFieldFocus    int
	profileFieldEditing  bool
	profileCursor        int
	editingProfileID     string
	profileLabelInput    textinput.Model
	profileProviderInput textinput.Model
	profileModelInput    textinput.Model
	profileBaseURLInput  textinput.Model
	profileAPIKeyInput   textinput.Model
	settingsReturnScreen string
	settingsCapturing    bool
	tuiSettings          TuiSettings

	transcriptCursor int
	approvalCursor   int
	taskCursor       int
	appCursor        int
	activityCursor   int
}

func NewApp(address string) App {
	settings := defaultTuiSettings()
	workingDirectory := ""
	loadedSettings, err := loadTuiSettings(workingDirectory)
	if err == nil {
		settings = loadedSettings
	}

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
		cwd:                  workingDirectory,
		address:              address,
		mode:                 mode,
		manager:              session.NewManager(),
		input:                input,
		rejectInput:          rejectInput,
		focus:                paneComposer,
		lastMainFocus:        paneTranscript,
		sessionScreen:        sessionScreenMain,
		profileFocus:         profileList,
		profileLabelInput:    profileLabelInput,
		profileProviderInput: profileProviderInput,
		profileModelInput:    profileModelInput,
		profileBaseURLInput:  profileBaseURLInput,
		profileAPIKeyInput:   profileAPIKeyInput,
		tuiSettings:          settings,
		sessionErr:           errorString(err),
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
	if a.sessionScreen == sessionScreenProfiles {
		return a.profileView()
	}
	if a.sessionScreen == sessionScreenSettings {
		return a.settingsView()
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
	key := message.String()
	if key == "ctrl+c" {
		return a, tea.Quit
	}

	if a.leaderPending {
		return a.handleLeaderKey(message)
	}

	if !a.rejectPromptOpen() && a.sessionScreen != sessionScreenSettings && key == a.tuiSettings.Keybinds.Leader {
		a.leaderPending = true
		a.sessionErr = ""
		return a, nil
	}

	if a.rejectPromptOpen() {
		return a.updateRejectPrompt(message)
	}
	if a.sessionScreen == sessionScreenProfiles {
		return a.updateProfiles(message)
	}
	if a.sessionScreen == sessionScreenSettings {
		return a.updateSettings(message)
	}

	if isPaneNavigationKey(key) && a.moveMainPane(key) {
		a.syncInputs()
		return a, nil
	}

	if a.focus == paneComposer {
		switch key {
		case "esc":
			a.leaveToDiscovery()
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

	switch key {
	case "esc":
		a.leaveToDiscovery()
		return a, discoverCmd()
	case "tab", "right":
		a.focus = nextPane(a.focus)
		a.syncInputs()
		return a, nil
	case "shift+tab", "left":
		a.focus = previousPane(a.focus)
		a.syncInputs()
		return a, nil
	case "up", "k":
		a.moveSelection(-1)
		return a, nil
	case "down", "j":
		a.moveSelection(1)
		return a, nil
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
	case "esc":
		if a.rejectEditing {
			a.rejectEditing = false
			a.syncInputs()
			return a, nil
		}
		a.closeRejectPrompt()
		a.syncInputs()
		return a, nil
	case "enter":
		if !a.rejectEditing {
			a.rejectEditing = true
			a.syncInputs()
			return a, nil
		}

		approvalID := a.rejectApprovalID
		reason := strings.TrimSpace(a.rejectInput.Value())
		a.closeRejectPrompt()
		a.syncInputs()
		if approvalID == "" {
			return a, nil
		}
		return a, rejectApprovalCmd(a.manager, approvalID, reason)
	}

	if !a.rejectEditing {
		return a, nil
	}

	var cmd tea.Cmd
	a.rejectInput, cmd = a.rejectInput.Update(message)
	return a, cmd
}

func (a App) updateProfiles(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.profileFocus == profileForm && a.profileFieldEditing {
		switch message.String() {
		case "esc", "enter":
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
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
	case "esc":
		if a.state.CanSendMessage {
			a.sessionScreen = sessionScreenMain
			a.focus = paneComposer
		} else {
			a.profileFocus = profileList
		}
		a.profileFieldEditing = false
		a.syncInputs()
		return a, nil
	case "tab":
		if a.profileFocus == profileForm {
			a.moveProfileField(1)
			a.syncInputs()
			return a, nil
		}
	case "shift+tab":
		if a.profileFocus == profileForm {
			a.moveProfileField(-1)
			a.syncInputs()
			return a, nil
		}
	case "left", "h":
		a.profileFocus = profileList
		a.profileFieldEditing = false
		a.syncInputs()
		return a, nil
	case "right", "l":
		a.profileFocus = profileForm
		a.profileFieldEditing = false
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
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
		}

		return a, nil
	}

	switch message.String() {
	case "up", "k":
		a.moveProfileField(-1)
		a.syncInputs()
		return a, nil
	case "down", "j":
		a.moveProfileField(1)
		a.syncInputs()
		return a, nil
	case "enter":
		a.profileFieldEditing = true
		a.syncInputs()
		return a, nil
	}

	return a, nil
}

func (a App) updateSettings(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.settingsCapturing {
		switch message.String() {
		case "esc":
			a.settingsCapturing = false
			a.sessionErr = ""
			return a, nil
		default:
			nextLeader := normalizeLeaderKey(message.String())
			if err := validateLeaderKey(nextLeader); err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}

			nextSettings := a.tuiSettings
			nextSettings.Keybinds.Leader = nextLeader
			if err := writeHomeTuiSettings(nextSettings); err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}

			a.tuiSettings = nextSettings
			a.settingsCapturing = false
			a.sessionErr = ""
			return a, nil
		}
	}

	switch message.String() {
	case "esc":
		a.sessionScreen = a.settingsReturnScreen
		if a.sessionScreen == "" {
			a.sessionScreen = sessionScreenMain
		}
		a.syncInputs()
		return a, nil
	case "enter":
		a.settingsCapturing = true
		a.sessionErr = ""
		return a, nil
	}

	return a, nil
}

func (a App) handleLeaderKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := message.String()
	a.leaderPending = false
	if key == "esc" || key == a.tuiSettings.Keybinds.Leader {
		return a, nil
	}

	if a.sessionScreen == sessionScreenProfiles {
		return a.handleProfileLeaderAction(key)
	}
	return a.handleMainLeaderAction(key)
}

func (a App) handleMainLeaderAction(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q":
		return a, tea.Quit
	case "p":
		a.openProfilesScreen()
		return a, nil
	case "s":
		a.openSettingsScreen(sessionScreenMain)
		return a, nil
	case "i":
		a.focus = paneComposer
		a.syncInputs()
		return a, nil
	case "t":
		if a.state.CanCancelTurn {
			return a, cancelTurnCmd(a.manager)
		}
	case "a":
		if approval := a.selectedApproval(); approval != nil && approval.CanApprove && a.focus == paneApprovals {
			return a, approveApprovalCmd(a.manager, approval.ID)
		}
	case "r":
		if approval := a.selectedApproval(); approval != nil && approval.CanReject && a.focus == paneApprovals {
			a.rejectApprovalID = approval.ID
			a.rejectInput.SetValue("")
			a.rejectEditing = false
			a.syncInputs()
			return a, nil
		}
	case "c":
		if task := a.selectedTask(); task != nil && task.CanCancel && a.focus == paneTasks {
			return a, cancelTaskCmd(a.manager, task.ID)
		}
	}

	return a, nil
}

func (a App) handleProfileLeaderAction(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q":
		return a, tea.Quit
	case "s":
		a.openSettingsScreen(sessionScreenProfiles)
		return a, nil
	case "w":
		if a.profileFocus == profileForm {
			params, err := a.profileSaveParams()
			if err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}
			return a, saveProfileCmd(a.manager, params)
		}
	case "n":
		if a.profileFocus == profileList {
			a.startNewProfileForm()
			a.profileFocus = profileForm
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
		}
	case "f":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil {
				return a, setDefaultProfileCmd(a.manager, profile.ID)
			}
		}
	case "d":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteProfile {
				return a, deleteProfileCmd(a.manager, profile.ID)
			}
		}
	case "x":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteAPIKey {
				return a, deleteAPIKeyCmd(a.manager, profile.ID)
			}
		}
	}

	return a, nil
}

func (a *App) openProfilesScreen() {
	a.sessionScreen = sessionScreenProfiles
	a.profileFocus = profileList
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.loadSelectedProfileIntoForm()
	a.syncInputs()
}

func (a *App) openSettingsScreen(returnScreen string) {
	a.settingsReturnScreen = returnScreen
	a.sessionScreen = sessionScreenSettings
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.syncInputs()
}

func (a *App) closeRejectPrompt() {
	a.rejectApprovalID = ""
	a.rejectInput.SetValue("")
	a.rejectEditing = false
}

func (a *App) leaveToDiscovery() {
	a.manager.Disconnect()
	a.state = session.ViewState{}
	a.address = ""
	a.mode = "discovery"
	a.leaderPending = false
	a.rejectApprovalID = ""
	a.rejectEditing = false
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.focus = paneComposer
	a.lastMainFocus = paneTranscript
	a.sessionScreen = sessionScreenMain
	a.settingsReturnScreen = sessionScreenMain
	a.syncInputs()
}

func (a *App) moveProfileField(delta int) {
	a.profileFieldFocus += delta
	if a.profileFieldFocus < 0 {
		a.profileFieldFocus = 0
	}
	if a.profileFieldFocus > 4 {
		a.profileFieldFocus = 4
	}
	a.profileFieldEditing = false
}

func (a App) profileSaveParams() (slop.Params, error) {
	provider := strings.TrimSpace(a.profileProviderInput.Value())
	model := strings.TrimSpace(a.profileModelInput.Value())
	if provider == "" || model == "" {
		return nil, fmt.Errorf("provider and model are required")
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
	return params, nil
}

func (a *App) moveMainPane(key string) bool {
	order := []paneFocus{paneTranscript, paneApprovals, paneTasks, paneApps, paneActivity, paneComposer}
	if a.sessionBodyWidth() < 112 {
		index := 0
		for i := range order {
			if order[i] == a.focus {
				index = i
				break
			}
		}
		switch key {
		case "shift+up", "shift+left":
			if index > 0 {
				a.focus = order[index-1]
				return true
			}
		case "shift+down", "shift+right":
			if index < len(order)-1 {
				a.focus = order[index+1]
				return true
			}
		}
		return false
	}

	next := a.focus
	switch a.focus {
	case paneTranscript:
		switch key {
		case "shift+right":
			next = paneApprovals
		case "shift+down":
			next = paneComposer
		}
	case paneApprovals:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+down":
			next = paneTasks
		}
	case paneTasks:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneApprovals
		case "shift+down":
			next = paneApps
		}
	case paneApps:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneTasks
		case "shift+down":
			next = paneActivity
		}
	case paneActivity:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneApps
		case "shift+down":
			next = paneComposer
		}
	case paneComposer:
		if key == "shift+up" {
			next = a.lastMainFocus
			if next == paneComposer {
				next = paneTranscript
			}
		}
	}

	if next == a.focus {
		return false
	}
	a.focus = next
	return true
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

func isPaneNavigationKey(key string) bool {
	return key == "shift+up" || key == "shift+down" || key == "shift+left" || key == "shift+right"
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
	panel := paneStyle(true, false).Width(bodyWidth).Height(panelHeight).Render(a.settingsPanelView(bodyWidth-4, panelHeight-2))
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

func renderInputRow(label string, input textinput.Model, focused bool, editing bool, width int) string {
	marker := ghostTextStyle.Render("·")
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
	if a.sessionErr != "" {
		lines = append(lines, "")
		lines = append(lines, warningStyle.Render(a.sessionErr))
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
		transcriptHeight := maxInt(height/2, 8)
		railHeight := maxInt(height-transcriptHeight-4, 16)
		approvalHeight := maxInt(railHeight/5, 5)
		taskHeight := maxInt(railHeight/5, 5)
		appsHeight := maxInt(railHeight/5, 5)
		activityHeight := maxInt(railHeight-approvalHeight-taskHeight-appsHeight-3, 7)

		transcript := paneStyle(a.focus == paneTranscript, false).Width(width).Height(transcriptHeight).Render(a.transcriptView(width-4, transcriptHeight-2))
		approvals := paneStyle(a.focus == paneApprovals, true).Width(width).Height(approvalHeight).Render(a.approvalsView(width-4, approvalHeight-2))
		tasks := paneStyle(a.focus == paneTasks, true).Width(width).Height(taskHeight).Render(a.tasksView(width-4, taskHeight-2))
		apps := paneStyle(a.focus == paneApps, true).Width(width).Height(appsHeight).Render(a.appsView(width-4, appsHeight-2))
		activity := paneStyle(a.focus == paneActivity, true).Width(width).Height(activityHeight).Render(a.activityView(width-4, activityHeight-2))

		return lipgloss.JoinVertical(lipgloss.Left, transcript, "", approvals, "", tasks, "", apps, "", activity)
	}

	leftWidth := maxInt((width*5)/8, 48)
	if leftWidth > width-32 {
		leftWidth = width - 32
	}
	rightWidth := maxInt(width-leftWidth-2, 30)
	approvalsHeight := maxInt(height/5, 6)
	tasksHeight := maxInt(height/5, 6)
	appsHeight := maxInt(height/5, 6)
	activityHeight := maxInt(height-approvalsHeight-tasksHeight-appsHeight-3, 8)

	transcript := paneStyle(a.focus == paneTranscript, false).Width(leftWidth).Height(height).Render(a.transcriptView(leftWidth-4, height-2))
	approvals := paneStyle(a.focus == paneApprovals, true).Width(rightWidth).Height(approvalsHeight).Render(a.approvalsView(rightWidth-4, approvalsHeight-2))
	tasks := paneStyle(a.focus == paneTasks, true).Width(rightWidth).Height(tasksHeight).Render(a.tasksView(rightWidth-4, tasksHeight-2))
	apps := paneStyle(a.focus == paneApps, true).Width(rightWidth).Height(appsHeight).Render(a.appsView(rightWidth-4, appsHeight-2))
	activity := paneStyle(a.focus == paneActivity, true).Width(rightWidth).Height(activityHeight).Render(a.activityView(rightWidth-4, activityHeight-2))
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
	for index := range a.state.Transcript {
		entryHeights[index] = transcriptEntryHeight(a.state.Transcript[index], width)
	}
	start, end := windowBoundsByHeights(entryHeights, a.transcriptCursor, availableHeight)
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

func (a App) appsView(width int, height int) string {
	var lines []string
	lines = append(lines, paneHeader("Apps", a.focus == paneApps, fmt.Sprintf("%d tracked", len(a.state.Apps))))
	lines = append(lines, "")

	if len(a.state.Apps) == 0 {
		lines = append(lines, ghostTextStyle.Render("No external apps discovered."))
		return strings.Join(lines, "\n")
	}

	visible := maxInt((height-2)/2, 1)
	start, end := windowBounds(len(a.state.Apps), a.appCursor, visible)
	for index := start; index < end; index++ {
		entry := a.state.Apps[index]
		selected := index == a.appCursor
		lines = append(lines, renderAppEntry(entry, selected, width))
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
		helpStyle.Render(a.sessionHelp()),
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
	a.appCursor = preserveCursor(len(previous.Apps), len(next.Apps), a.appCursor)
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

	if (!next.CanSendMessage || next.LlmStatus != "ready") && a.sessionScreen == sessionScreenMain {
		a.sessionScreen = sessionScreenProfiles
	}
	if a.sessionScreen == sessionScreenProfiles {
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
	if a.sessionScreen == sessionScreenMain && !a.rejectPromptOpen() && a.focus != paneComposer {
		a.lastMainFocus = a.focus
	}

	if a.rejectPromptOpen() {
		a.blurProfileInputs()
		if a.rejectEditing {
			a.rejectInput.Focus()
		} else {
			a.rejectInput.Blur()
		}
		a.input.Blur()
		return
	}

	a.rejectInput.Blur()
	if a.sessionScreen == sessionScreenProfiles {
		a.input.Blur()
		if a.profileFocus != profileForm || !a.profileFieldEditing {
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
	if a.sessionScreen == sessionScreenSettings {
		a.blurProfileInputs()
		a.input.Blur()
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
	case paneApps:
		a.appCursor = clampRange(a.appCursor+delta, len(a.state.Apps))
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
	lines := transcriptEntryLines(entry, width, selected)
	return renderListItem(selected, width, lines)
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
	return lines
}

func transcriptEntryHeight(entry session.TranscriptEntry, width int) int {
	return len(transcriptEntryLines(entry, width, false))
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
		if a.rejectEditing {
			return "enter reject  esc stop editing  ctrl+c quit"
		}
		return "enter edit  esc cancel  ctrl+c quit"
	}

	if a.leaderPending {
		switch a.focus {
		case paneApprovals:
			return "leader pending  a approve  r reject  p profiles  s settings  t cancel turn  q quit"
		case paneTasks:
			return "leader pending  c cancel task  p profiles  s settings  t cancel turn  q quit"
		default:
			return "leader pending  p profiles  s settings  i compose  t cancel turn  q quit"
		}
	}

	switch a.focus {
	case paneComposer:
		return fmt.Sprintf("shift+arrows panes  tab cycle  enter send  %s actions  esc back  ctrl+c quit", a.tuiSettings.Keybinds.Leader)
	case paneApprovals:
		return fmt.Sprintf("arrows move  shift+arrows panes  enter approve  %s actions  esc back", a.tuiSettings.Keybinds.Leader)
	case paneTasks:
		return fmt.Sprintf("arrows move  shift+arrows panes  enter cancel task  %s actions  esc back", a.tuiSettings.Keybinds.Leader)
	default:
		return fmt.Sprintf("arrows move  shift+arrows panes  left/right cycle  %s actions  esc back", a.tuiSettings.Keybinds.Leader)
	}
}

func (a App) profileHelp() string {
	if a.leaderPending {
		if a.profileFocus == profileForm {
			return "leader pending  w save  s settings  q quit"
		}
		return "leader pending  n new  f default  d delete  x drop key  s settings  q quit"
	}

	if a.profileFocus == profileList {
		if a.state.CanSendMessage {
			return fmt.Sprintf("arrows move  enter open form  right form  %s new  %s settings  esc back", a.leaderBinding("n"), a.leaderBinding("s"))
		}
		return fmt.Sprintf("arrows move  enter open form  right form  %s new  %s settings  ctrl+c quit", a.leaderBinding("n"), a.leaderBinding("s"))
	}

	if a.profileFieldEditing {
		return fmt.Sprintf("type value  enter finish  esc stop editing  %s save", a.leaderBinding("w"))
	}

	if a.state.CanSendMessage {
		return fmt.Sprintf("arrows fields  tab next  enter edit  left list  %s save  %s settings  esc back", a.leaderBinding("w"), a.leaderBinding("s"))
	}
	return fmt.Sprintf("arrows fields  tab next  enter edit  left list  %s save  %s settings  esc list  ctrl+c quit", a.leaderBinding("w"), a.leaderBinding("s"))
}

func (a App) settingsHelp() string {
	if a.settingsCapturing {
		return "press desired leader  esc cancel  ctrl+c quit"
	}
	return "enter capture  esc back  ctrl+c quit"
}

func (a App) leaderBinding(key string) string {
	if strings.TrimSpace(key) == "" {
		return a.tuiSettings.Keybinds.Leader
	}
	return fmt.Sprintf("%s %s", a.tuiSettings.Keybinds.Leader, key)
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
