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
	colorDanger           = "#ff8f8f"
	colorWarning          = "#ffd479"
)

var (
	appStyle            = lipgloss.NewStyle().Background(lipgloss.Color(colorSurface)).Foreground(lipgloss.Color(colorText)).Padding(1, 2)
	titleStyle          = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	accentTitleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorPrimary))
	mutedStyle          = lipgloss.NewStyle().Foreground(lipgloss.Color(colorMuted))
	helpStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color(colorSubtle))
	labelStyle          = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorSecondary))
	metaLabelStyle      = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorMuted))
	keyStyle            = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorPrimary))
	codeStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color(colorText))
	selectedRowStyle    = lipgloss.NewStyle().Background(lipgloss.Color(colorSurfaceHigh)).Foreground(lipgloss.Color(colorText)).Padding(0, 1)
	rowStyle            = lipgloss.NewStyle().Foreground(lipgloss.Color(colorText)).Padding(0, 1)
	successStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorPrimary))
	dangerStyle         = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorDanger))
	warningStyle        = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorWarning))
	ghostTextStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color(colorSubtle))
	selectedAccentStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorPrimary))
)

func paneStyle(focused bool, elevated bool) lipgloss.Style {
	background := colorSurfaceLow
	if elevated {
		background = colorSurfaceContainer
	}
	if focused {
		background = colorSurfaceHigh
	}

	return lipgloss.NewStyle().
		Background(lipgloss.Color(background)).
		Foreground(lipgloss.Color(colorText)).
		Padding(1, 2)
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
		Width(width)
}
