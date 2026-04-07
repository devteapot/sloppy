package session

import (
	"errors"
	"testing"

	slop "github.com/devteapot/slop/packages/go/slop-ai"
)

func TestBuildViewParsesSessionPanesAndActions(t *testing.T) {
	tree := &slop.WireNode{
		ID:   "root",
		Type: "group",
		Children: []slop.WireNode{
			{
				ID:   "session",
				Type: "context",
				Properties: slop.Props{
					"title":          "Nocturnal Session",
					"status":         "active",
					"model_provider": "openai",
					"model":          "gpt-5.4",
				},
			},
			{
				ID:   "llm",
				Type: "collection",
				Properties: slop.Props{
					"status":              "needs_credentials",
					"message":             "Add an API key for openai gpt-5.4 or set OPENAI_API_KEY.",
					"secure_store_kind":   "keychain",
					"secure_store_status": "available",
				},
				Children: []slop.WireNode{{
					ID:   "profile-1",
					Type: "item",
					Properties: slop.Props{
						"label":              "Primary",
						"provider":           "openai",
						"model":              "gpt-5.4",
						"api_key_env":        "OPENAI_API_KEY",
						"ready":              false,
						"is_default":         true,
						"managed":            true,
						"origin":             "managed",
						"has_key":            false,
						"key_source":         "missing",
						"can_delete_profile": true,
						"can_delete_api_key": true,
					},
				}},
			},
			{
				ID:   "turn",
				Type: "status",
				Properties: slop.Props{
					"state":   "waiting_approval",
					"message": "Command marked dangerous",
				},
				Affordances: []slop.Affordance{{Action: "cancel_turn"}},
			},
			{
				ID:   "composer",
				Type: "control",
				Properties: slop.Props{
					"disabled_reason": "Add an API key for openai gpt-5.4 or set OPENAI_API_KEY.",
				},
			},
			{
				ID:   "transcript",
				Type: "collection",
				Children: []slop.WireNode{
					{
						ID:   "msg-1",
						Type: "item",
						Properties: slop.Props{
							"role":   "assistant",
							"state":  "streaming",
							"author": "gpt-5.4",
						},
						Children: []slop.WireNode{{
							ID:   "content",
							Type: "group",
							Children: []slop.WireNode{{
								ID:   "block-1",
								Type: "document",
								Properties: slop.Props{
									"text": "Streaming response",
								},
							}},
						}},
					},
				},
			},
			{
				ID:   "activity",
				Type: "collection",
				Children: []slop.WireNode{{
					ID:   "activity-1",
					Type: "item",
					Properties: slop.Props{
						"kind":     "tool_call",
						"status":   "running",
						"summary":  "Preparing command",
						"provider": "terminal",
						"path":     "/session",
						"action":   "execute",
					},
				}},
			},
			{
				ID:   "approvals",
				Type: "collection",
				Children: []slop.WireNode{{
					ID:   "approval-1",
					Type: "item",
					Properties: slop.Props{
						"status":         "pending",
						"provider":       "terminal",
						"path":           "/session",
						"action":         "execute",
						"reason":         "Command marked dangerous",
						"params_preview": "rm -rf build",
						"dangerous":      true,
					},
					Affordances: []slop.Affordance{{Action: "approve"}, {Action: "reject"}},
				}},
			},
			{
				ID:   "tasks",
				Type: "collection",
				Children: []slop.WireNode{{
					ID:   "task-1",
					Type: "item",
					Properties: slop.Props{
						"status":           "running",
						"provider":         "terminal",
						"provider_task_id": "task-123",
						"message":          "Running tests",
						"progress":         0.5,
						"error":            "",
					},
					Affordances: []slop.Affordance{{Action: "cancel"}},
				}},
			},
			{
				ID:   "apps",
				Type: "collection",
				Children: []slop.WireNode{{
					ID:   "native-demo",
					Type: "item",
					Properties: slop.Props{
						"provider_id": "native-demo",
						"name":        "Native Demo",
						"transport":   "unix:/tmp/native-demo.sock",
						"status":      "connected",
					},
				}},
			},
		},
	}

	state := BuildView(tree, nil)

	if state.SessionTitle != "Nocturnal Session" {
		t.Fatalf("expected session title, got %q", state.SessionTitle)
	}
	if state.Model != "openai gpt-5.4" {
		t.Fatalf("expected model summary, got %q", state.Model)
	}
	if state.LlmStatus != "needs_credentials" || state.CanSendMessage {
		t.Fatalf("expected llm onboarding state to disable composer, got status=%q canSend=%v", state.LlmStatus, state.CanSendMessage)
	}
	if len(state.Profiles) != 1 || state.Profiles[0].Provider != "openai" {
		t.Fatalf("expected llm profile metadata to be parsed, got %#v", state.Profiles)
	}
	if state.Profiles[0].Origin != "managed" || !state.Profiles[0].CanDeleteProfile || !state.Profiles[0].CanDeleteAPIKey {
		t.Fatalf("expected llm profile origin and capabilities to be parsed, got %#v", state.Profiles[0])
	}
	if state.TurnState != "waiting_approval" || !state.CanCancelTurn {
		t.Fatalf("expected waiting approval turn with cancel affordance, got state=%q cancel=%v", state.TurnState, state.CanCancelTurn)
	}
	if len(state.Transcript) != 1 || state.Transcript[0].Text != "Streaming response" {
		t.Fatalf("expected transcript content to be extracted, got %#v", state.Transcript)
	}
	if len(state.Activity) != 1 || state.Activity[0].Provider != "terminal" {
		t.Fatalf("expected activity metadata to be parsed, got %#v", state.Activity)
	}
	if len(state.Approvals) != 1 {
		t.Fatalf("expected one approval entry, got %d", len(state.Approvals))
	}
	if !state.Approvals[0].CanApprove || !state.Approvals[0].CanReject || !state.Approvals[0].Dangerous {
		t.Fatalf("expected approval actions and danger flag, got %#v", state.Approvals[0])
	}
	if len(state.Tasks) != 1 {
		t.Fatalf("expected one task entry, got %d", len(state.Tasks))
	}
	if !state.Tasks[0].CanCancel || !state.Tasks[0].HasProgress || state.Tasks[0].Progress != 0.5 {
		t.Fatalf("expected task affordance and progress, got %#v", state.Tasks[0])
	}
	if len(state.Apps) != 1 || state.Apps[0].ID != "native-demo" {
		t.Fatalf("expected app attachment metadata to be parsed, got %#v", state.Apps)
	}
	if state.Apps[0].Transport != "unix:/tmp/native-demo.sock" || state.Apps[0].Status != "connected" {
		t.Fatalf("expected app transport and status to be parsed, got %#v", state.Apps[0])
	}
}

func TestBuildViewCarriesManagerErrors(t *testing.T) {
	state := BuildView(nil, errors.New("disconnected"))
	if state.Error != "disconnected" {
		t.Fatalf("expected manager error to be surfaced, got %q", state.Error)
	}
}
