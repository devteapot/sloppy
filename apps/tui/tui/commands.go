package tui

import (
	"context"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	slop "github.com/devteapot/slop/packages/go/slop-ai"
	"github.com/devteapot/sloppy/apps/tui/provider"
	"github.com/devteapot/sloppy/apps/tui/session"
)

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

func acceptOrchestrationGateCmd(manager *session.Manager, gateID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.AcceptOrchestrationGate(ctx, gateID)}
	}
}

func rejectOrchestrationGateCmd(manager *session.Manager, gateID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.RejectOrchestrationGate(ctx, gateID)}
	}
}

func runDigestActionCmd(manager *session.Manager, actionID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return sessionActionMsg{err: manager.RunDigestAction(ctx, actionID)}
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
