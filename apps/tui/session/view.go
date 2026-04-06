package session

import (
	"fmt"
	"strings"

	slop "github.com/devteapot/slop/packages/go/slop-ai"
)

type TranscriptEntry struct {
	Role  string
	State string
	Text  string
}

type ActivityEntry struct {
	Kind    string
	Status  string
	Summary string
}

type ViewState struct {
	SessionTitle  string
	SessionStatus string
	Model         string
	TurnState     string
	TurnMessage   string
	Transcript    []TranscriptEntry
	Activity      []ActivityEntry
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
	}

	if transcriptNode := findChild(tree, "transcript"); transcriptNode != nil {
		for i := range transcriptNode.Children {
			child := &transcriptNode.Children[i]
			state.Transcript = append(state.Transcript, TranscriptEntry{
				Role:  stringProp(child, "role"),
				State: stringProp(child, "state"),
				Text:  extractTranscriptText(child),
			})
		}
	}

	if activityNode := findChild(tree, "activity"); activityNode != nil {
		for i := range activityNode.Children {
			child := &activityNode.Children[i]
			state.Activity = append(state.Activity, ActivityEntry{
				Kind:    stringProp(child, "kind"),
				Status:  stringProp(child, "status"),
				Summary: stringProp(child, "summary"),
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
