package session

import (
	"fmt"
	"strings"

	slop "github.com/devteapot/slop/packages/go/slop-ai"
)

type TranscriptEntry struct {
	ID     string
	Role   string
	State  string
	Author string
	Text   string
}

type ActivityEntry struct {
	ID       string
	Kind     string
	Status   string
	Summary  string
	Provider string
	Path     string
	Action   string
}

type ApprovalEntry struct {
	ID            string
	Status        string
	Provider      string
	Path          string
	Action        string
	Reason        string
	ParamsPreview string
	Dangerous     bool
	CanApprove    bool
	CanReject     bool
}

type TaskEntry struct {
	ID             string
	Status         string
	Provider       string
	ProviderTaskID string
	Message        string
	Progress       float64
	HasProgress    bool
	Error          string
	CanCancel      bool
}

type ViewState struct {
	SessionTitle  string
	SessionStatus string
	Model         string
	TurnState     string
	TurnMessage   string
	CanCancelTurn bool
	Transcript    []TranscriptEntry
	Activity      []ActivityEntry
	Approvals     []ApprovalEntry
	Tasks         []TaskEntry
	Error         string
}

func BuildView(tree *slop.WireNode, err error) ViewState {
	state := ViewState{}
	if err != nil {
		state.Error = err.Error()
	}
	if tree == nil {
		return state
	}

	if sessionNode := findChild(tree, "session"); sessionNode != nil {
		state.SessionTitle = stringProp(sessionNode, "title")
		if state.SessionTitle == "" {
			state.SessionTitle = stringProp(sessionNode, "session_id")
		}
		state.SessionStatus = stringProp(sessionNode, "status")
		modelProvider := stringProp(sessionNode, "model_provider")
		model := stringProp(sessionNode, "model")
		if modelProvider != "" || model != "" {
			state.Model = strings.TrimSpace(fmt.Sprintf("%s %s", modelProvider, model))
		}
	}

	if turnNode := findChild(tree, "turn"); turnNode != nil {
		state.TurnState = stringProp(turnNode, "state")
		state.TurnMessage = stringProp(turnNode, "message")
		state.CanCancelTurn = hasAffordance(turnNode, "cancel_turn")
	}

	if transcriptNode := findChild(tree, "transcript"); transcriptNode != nil {
		for i := range transcriptNode.Children {
			child := &transcriptNode.Children[i]
			state.Transcript = append(state.Transcript, TranscriptEntry{
				ID:     child.ID,
				Role:   stringProp(child, "role"),
				State:  stringProp(child, "state"),
				Author: stringProp(child, "author"),
				Text:   extractTranscriptText(child),
			})
		}
	}

	if activityNode := findChild(tree, "activity"); activityNode != nil {
		for i := range activityNode.Children {
			child := &activityNode.Children[i]
			state.Activity = append(state.Activity, ActivityEntry{
				ID:       child.ID,
				Kind:     stringProp(child, "kind"),
				Status:   stringProp(child, "status"),
				Summary:  stringProp(child, "summary"),
				Provider: stringProp(child, "provider"),
				Path:     stringProp(child, "path"),
				Action:   stringProp(child, "action"),
			})
		}
	}

	if approvalsNode := findChild(tree, "approvals"); approvalsNode != nil {
		for i := range approvalsNode.Children {
			child := &approvalsNode.Children[i]
			state.Approvals = append(state.Approvals, ApprovalEntry{
				ID:            child.ID,
				Status:        stringProp(child, "status"),
				Provider:      stringProp(child, "provider"),
				Path:          stringProp(child, "path"),
				Action:        stringProp(child, "action"),
				Reason:        stringProp(child, "reason"),
				ParamsPreview: stringProp(child, "params_preview"),
				Dangerous:     boolProp(child, "dangerous"),
				CanApprove:    hasAffordance(child, "approve"),
				CanReject:     hasAffordance(child, "reject"),
			})
		}
	}

	if tasksNode := findChild(tree, "tasks"); tasksNode != nil {
		for i := range tasksNode.Children {
			child := &tasksNode.Children[i]
			progress, hasProgress := numberProp(child, "progress")
			state.Tasks = append(state.Tasks, TaskEntry{
				ID:             child.ID,
				Status:         stringProp(child, "status"),
				Provider:       stringProp(child, "provider"),
				ProviderTaskID: stringProp(child, "provider_task_id"),
				Message:        stringProp(child, "message"),
				Progress:       progress,
				HasProgress:    hasProgress,
				Error:          stringProp(child, "error"),
				CanCancel:      hasAffordance(child, "cancel"),
			})
		}
	}

	return state
}

func findChild(node *slop.WireNode, id string) *slop.WireNode {
	if node == nil {
		return nil
	}

	for i := range node.Children {
		child := &node.Children[i]
		if child.ID == id {
			return child
		}
	}

	return nil
}

func stringProp(node *slop.WireNode, key string) string {
	if node == nil || node.Properties == nil {
		return ""
	}

	value, ok := node.Properties[key]
	if !ok {
		return ""
	}

	if text, ok := value.(string); ok {
		return text
	}

	return fmt.Sprintf("%v", value)
}

func boolProp(node *slop.WireNode, key string) bool {
	if node == nil || node.Properties == nil {
		return false
	}

	value, ok := node.Properties[key]
	if !ok {
		return false
	}

	boolean, ok := value.(bool)
	return ok && boolean
}

func numberProp(node *slop.WireNode, key string) (float64, bool) {
	if node == nil || node.Properties == nil {
		return 0, false
	}

	value, ok := node.Properties[key]
	if !ok {
		return 0, false
	}

	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	default:
		return 0, false
	}
}

func hasAffordance(node *slop.WireNode, action string) bool {
	if node == nil {
		return false
	}

	for i := range node.Affordances {
		if node.Affordances[i].Action == action {
			return true
		}
	}

	return false
}

func extractTranscriptText(node *slop.WireNode) string {
	content := findChild(node, "content")
	if content == nil {
		return ""
	}

	blocks := make([]string, 0, len(content.Children))
	for i := range content.Children {
		text := stringProp(&content.Children[i], "text")
		if text != "" {
			blocks = append(blocks, text)
		}
	}

	return strings.Join(blocks, "")
}
