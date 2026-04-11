package tui

import (
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
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
	transcriptPinned bool
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
		transcriptPinned:     true,
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
		a.transcriptPinned = true
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
