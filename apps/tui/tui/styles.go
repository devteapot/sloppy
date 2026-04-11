package tui

import "github.com/charmbracelet/lipgloss"

const (
	colorSurface          = "#111319"
	colorSurfaceLowest    = "#0c0e14"
	colorSurfaceLow       = "#151922"
	colorSurfaceContainer = "#1a2130"
	colorSurfaceHigh      = "#232c3d"
	colorText             = "#e6ecff"
	colorMuted            = "#8a93a8"
	colorSubtle           = "#667089"
	colorPrimary          = "#91db37"
	colorSecondary        = "#adc6ff"
	colorSuccess          = "#6fad3a"
	colorDanger           = "#ff8f8f"
	colorWarning          = "#ffd479"
	colorGhostBorder      = "#1e2436"
)

var (
	appStyle            = lipgloss.NewStyle().Background(lipgloss.Color(colorSurface)).Foreground(lipgloss.Color(colorText)).Padding(1, 2)
	titleStyle          = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	accentTitleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorPrimary))
	mutedStyle          = lipgloss.NewStyle().Foreground(lipgloss.Color(colorMuted))
	helpStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color(colorSubtle))
	helpKeyStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorMuted))
	labelStyle          = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	metaLabelStyle      = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorMuted))
	keyStyle            = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	promptStyle         = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	codeStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color(colorText))
	selectedRowStyle    = lipgloss.NewStyle().Background(lipgloss.Color(colorSurfaceHigh)).Foreground(lipgloss.Color(colorText)).Padding(0, 1)
	rowStyle            = lipgloss.NewStyle().Foreground(lipgloss.Color(colorText)).Padding(0, 1)
	successStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSuccess))
	dangerStyle         = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorDanger))
	warningStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorWarning))
	ghostTextStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color(colorSubtle))
	selectedAccentStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
)

func paneStyle(focused bool, elevated bool) lipgloss.Style {
	background := colorSurfaceLow
	if elevated {
		background = colorSurfaceContainer
	}
	if focused {
		background = colorSurfaceHigh
	}

	borderColor := colorGhostBorder
	if focused {
		borderColor = colorSecondary
	}

	return lipgloss.NewStyle().
		Background(lipgloss.Color(background)).
		Foreground(lipgloss.Color(colorText)).
		Padding(1, 2).
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.Color(borderColor))
}

func composerStyle(focused bool) lipgloss.Style {
	background := colorSurfaceLowest
	if focused {
		background = colorSurfaceContainer
	}

	return lipgloss.NewStyle().
		Background(lipgloss.Color(background)).
		Foreground(lipgloss.Color(colorText)).
		Padding(1, 2)
}

func modalStyle(width int) lipgloss.Style {
	return lipgloss.NewStyle().
		Background(lipgloss.Color(colorSurfaceHigh)).
		Foreground(lipgloss.Color(colorText)).
		Padding(1, 2).
		Width(width).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colorSubtle))
}
