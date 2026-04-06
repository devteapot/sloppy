package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

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

type refreshSessionMsg struct{}

type sendMessageMsg struct {
	err error
}

type App struct {
	width  int
	height int

	address   string
	mode      string
	cursor    int
	providers []provider.Descriptor
	err       error

	manager *session.Manager
	state   session.ViewState
	input   textinput.Model
}

func NewApp(address string) App {
	input := textinput.New()
	input.Placeholder = "Ask the agent..."
	input.CharLimit = 4096
	input.Width = 72
	input.Focus()

	mode := "discovery"
	if address != "" {
		mode = "session"
	}

	return App{
		address: address,
		mode:    mode,
		manager: session.NewManager(),
		input:   input,
	}
}

func (a App) Init() tea.Cmd {
	if a.address != "" {
		return tea.Batch(connectCmd(a.manager, a.address), tickSession())
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
			a.cursor = maxInt(len(a.providers)-1, 0)
		}
		return a, nil

	case connectMsg:
		a.err = message.err
		if message.err == nil {
			a.mode = "session"
			return a, tickSession()
		}
		return a, nil

	case refreshSessionMsg:
		tree, err := a.manager.Snapshot()
		a.state = session.BuildView(tree, err)
		return a, tickSession()

	case sendMessageMsg:
		a.err = message.err
		if message.err == nil {
			a.input.SetValue("")
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
	switch message.String() {
	case "ctrl+c", "q":
		return a, tea.Quit
	case "esc":
		a.manager.Disconnect()
		a.state = session.ViewState{}
		a.address = ""
		a.mode = "discovery"
		return a, discoverCmd()
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

func (a App) discoveryView() string {
	var lines []string
	lines = append(lines, titleStyle.Render("Sloppy TUI"))
	lines = append(lines, mutedStyle.Render("Attach to a running agent-session provider"))
	lines = append(lines, "")

	if len(a.providers) == 0 {
		lines = append(lines, mutedStyle.Render("No session providers found. Start `bun run session:serve` first."))
	} else {
		for i, descriptor := range a.providers {
			cursor := "  "
			if i == a.cursor {
				cursor = "> "
			}
			name := descriptor.Name
			if name == "" {
				name = descriptor.ID
			}
			lines = append(lines, fmt.Sprintf("%s%s  %s", cursor, name, mutedStyle.Render(descriptor.Address())))
		}
	}

	if a.err != nil {
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render(a.err.Error()))
	}

	lines = append(lines, "")
	lines = append(lines, helpStyle.Render("enter connect  r refresh  q quit"))
	return pad(strings.Join(lines, "\n"))
}

func (a App) sessionView() string {
	leftWidth := maxInt(a.width/2-2, 40)
	rightWidth := maxInt(a.width-leftWidth-6, 32)
	left := borderStyle.Width(leftWidth).Padding(1).Render(a.transcriptView())
	right := borderStyle.Width(rightWidth).Padding(1).Render(a.activityView())
	composer := borderStyle.Width(maxInt(a.width-4, 72)).Padding(1).Render(a.composerView())
	return pad(strings.Join([]string{left + right, "", composer}, "\n"))
}

func (a App) transcriptView() string {
	var lines []string
	title := a.state.SessionTitle
	if title == "" {
		title = "Session"
	}
	lines = append(lines, titleStyle.Render(title))
	statusLine := strings.TrimSpace(fmt.Sprintf("%s  %s", a.state.SessionStatus, a.state.Model))
	if statusLine != "" {
		lines = append(lines, mutedStyle.Render(statusLine))
	}
	if a.state.TurnState != "" || a.state.TurnMessage != "" {
		lines = append(lines, mutedStyle.Render(fmt.Sprintf("turn: %s  %s", a.state.TurnState, a.state.TurnMessage)))
	}
	lines = append(lines, "")

	if len(a.state.Transcript) == 0 {
		lines = append(lines, mutedStyle.Render("No messages yet."))
	} else {
		start := maxInt(len(a.state.Transcript)-10, 0)
		for _, entry := range a.state.Transcript[start:] {
			role := strings.ToUpper(entry.Role)
			lines = append(lines, fmt.Sprintf("%s: %s", role, entry.Text))
		}
	}

	if a.state.Error != "" {
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render(a.state.Error))
	}

	return strings.Join(lines, "\n")
}

func (a App) activityView() string {
	var lines []string
	lines = append(lines, titleStyle.Render("Activity"))
	lines = append(lines, "")

	if len(a.state.Activity) == 0 {
		lines = append(lines, mutedStyle.Render("No activity yet."))
	} else {
		start := maxInt(len(a.state.Activity)-12, 0)
		for _, entry := range a.state.Activity[start:] {
			lines = append(lines, fmt.Sprintf("[%s] %s", entry.Kind, entry.Summary))
			if entry.Status != "" {
				lines = append(lines, mutedStyle.Render("  status: "+entry.Status))
			}
		}
	}

	lines = append(lines, "")
	lines = append(lines, helpStyle.Render("esc back  q quit"))
	return strings.Join(lines, "\n")
}

func (a App) composerView() string {
	return strings.Join([]string{
		titleStyle.Render("Composer"),
		"",
		a.input.View(),
		"",
		helpStyle.Render("enter send message"),
	}, "\n")
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

func tickSession() tea.Cmd {
	return tea.Tick(150*time.Millisecond, func(time.Time) tea.Msg {
		return refreshSessionMsg{}
	})
}

func pad(content string) string {
	return "\n" + content + "\n"
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
