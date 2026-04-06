package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/devteapot/sloppy/apps/tui/tui"
)

func main() {
	address := ""
	if len(os.Args) > 1 {
		address = os.Args[1]
	}

	program := tea.NewProgram(tui.NewApp(address), tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "tui failed: %v\n", err)
		os.Exit(1)
	}
}
