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

type AppEntry struct {
	ID        string
	Name      string
	Transport string
	Status    string
	LastError string
}

type OrchestrationGateEntry struct {
	ID         string
	Type       string
	Status     string
	SubjectRef string
	Summary    string
	CanAccept  bool
	CanReject  bool
}

type DigestActionEntry struct {
	ID         string
	Kind       string
	Label      string
	TargetRef  string
	ActionPath string
	ActionName string
	Urgency    string
	CanRun     bool
}

type OrchestrationSummary struct {
	Available                      bool
	Provider                       string
	PlanID                         string
	PlanStatus                     string
	FinalAuditStatus               string
	LatestDigestID                 string
	LatestDigestStatus             string
	LatestDigestDeliveryError      string
	PendingDigestDeliveryCount     int
	PendingGateCount               int
	LatestBlockingGateID           string
	LatestBlockingGateType         string
	LatestBlockingGateSummary      string
	ActiveSliceCount               int
	CompletedSliceCount            int
	FailedSliceCount               int
	PrecedentResolvedCount         int
	SemanticPrecedentResolvedCount int
	PrecedentEscalatedCount        int
	OpenDriftEventCount            int
	BlockingDriftEventCount        int
	Gates                          []OrchestrationGateEntry
	DigestActions                  []DigestActionEntry
}

type LlmProfileEntry struct {
	ID               string
	Label            string
	Provider         string
	Model            string
	APIKeyEnv        string
	BaseURL          string
	KeySource        string
	Origin           string
	Ready            bool
	IsDefault        bool
	Managed          bool
	HasKey           bool
	CanDeleteProfile bool
	CanDeleteAPIKey  bool
}

type ViewState struct {
	SessionTitle      string
	SessionStatus     string
	Model             string
	LlmStatus         string
	LlmMessage        string
	CanSendMessage    bool
	SecureStoreKind   string
	SecureStoreStatus string
	TurnState         string
	TurnMessage       string
	CanCancelTurn     bool
	Profiles          []LlmProfileEntry
	Transcript        []TranscriptEntry
	Activity          []ActivityEntry
	Approvals         []ApprovalEntry
	Tasks             []TaskEntry
	Apps              []AppEntry
	Orchestration     OrchestrationSummary
	Error             string
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

	if llmNode := findChild(tree, "llm"); llmNode != nil {
		state.LlmStatus = stringProp(llmNode, "status")
		state.LlmMessage = stringProp(llmNode, "message")
		state.SecureStoreKind = stringProp(llmNode, "secure_store_kind")
		state.SecureStoreStatus = stringProp(llmNode, "secure_store_status")

		for i := range llmNode.Children {
			child := &llmNode.Children[i]
			label := stringProp(child, "label")
			if label == "" {
				label = strings.TrimSpace(fmt.Sprintf("%s %s", stringProp(child, "provider"), stringProp(child, "model")))
			}
			state.Profiles = append(state.Profiles, LlmProfileEntry{
				ID:               child.ID,
				Label:            label,
				Provider:         stringProp(child, "provider"),
				Model:            stringProp(child, "model"),
				APIKeyEnv:        stringProp(child, "api_key_env"),
				BaseURL:          stringProp(child, "base_url"),
				KeySource:        stringProp(child, "key_source"),
				Origin:           stringProp(child, "origin"),
				Ready:            boolProp(child, "ready"),
				IsDefault:        boolProp(child, "is_default"),
				Managed:          boolProp(child, "managed"),
				HasKey:           boolProp(child, "has_key"),
				CanDeleteProfile: boolProp(child, "can_delete_profile"),
				CanDeleteAPIKey:  boolProp(child, "can_delete_api_key"),
			})
		}
	}

	if composerNode := findChild(tree, "composer"); composerNode != nil {
		state.CanSendMessage = hasAffordance(composerNode, "send_message")
		if !state.CanSendMessage && state.LlmMessage == "" {
			state.LlmMessage = stringProp(composerNode, "disabled_reason")
		}
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

	if appsNode := findChild(tree, "apps"); appsNode != nil {
		for i := range appsNode.Children {
			child := &appsNode.Children[i]
			state.Apps = append(state.Apps, AppEntry{
				ID:        stringProp(child, "provider_id"),
				Name:      stringProp(child, "name"),
				Transport: stringProp(child, "transport"),
				Status:    stringProp(child, "status"),
				LastError: stringProp(child, "last_error"),
			})
			if state.Apps[len(state.Apps)-1].ID == "" {
				state.Apps[len(state.Apps)-1].ID = child.ID
			}
		}
	}

	if orchestrationNode := findChild(tree, "orchestration"); orchestrationNode != nil {
		canAcceptGate := hasAffordance(orchestrationNode, "accept_gate")
		canRejectGate := hasAffordance(orchestrationNode, "reject_gate")
		canRunDigestAction := hasAffordance(orchestrationNode, "run_digest_action")
		state.Orchestration = OrchestrationSummary{
			Available:                      boolProp(orchestrationNode, "available"),
			Provider:                       stringProp(orchestrationNode, "provider"),
			PlanID:                         stringProp(orchestrationNode, "plan_id"),
			PlanStatus:                     stringProp(orchestrationNode, "plan_status"),
			FinalAuditStatus:               stringProp(orchestrationNode, "final_audit_status"),
			LatestDigestID:                 stringProp(orchestrationNode, "latest_digest_id"),
			LatestDigestStatus:             stringProp(orchestrationNode, "latest_digest_status"),
			LatestDigestDeliveryError:      stringProp(orchestrationNode, "latest_digest_delivery_error"),
			PendingDigestDeliveryCount:     intProp(orchestrationNode, "pending_digest_delivery_count"),
			PendingGateCount:               intProp(orchestrationNode, "pending_gate_count"),
			LatestBlockingGateID:           stringProp(orchestrationNode, "latest_blocking_gate_id"),
			LatestBlockingGateType:         stringProp(orchestrationNode, "latest_blocking_gate_type"),
			LatestBlockingGateSummary:      stringProp(orchestrationNode, "latest_blocking_gate_summary"),
			ActiveSliceCount:               intProp(orchestrationNode, "active_slice_count"),
			CompletedSliceCount:            intProp(orchestrationNode, "completed_slice_count"),
			FailedSliceCount:               intProp(orchestrationNode, "failed_slice_count"),
			PrecedentResolvedCount:         intProp(orchestrationNode, "precedent_resolved_count"),
			SemanticPrecedentResolvedCount: intProp(orchestrationNode, "semantic_precedent_resolved_count"),
			PrecedentEscalatedCount:        intProp(orchestrationNode, "precedent_escalated_count"),
			OpenDriftEventCount:            intProp(orchestrationNode, "open_drift_event_count"),
			BlockingDriftEventCount:        intProp(orchestrationNode, "blocking_drift_event_count"),
		}
		for _, gate := range recordSliceProp(orchestrationNode, "pending_gates") {
			state.Orchestration.Gates = append(state.Orchestration.Gates, OrchestrationGateEntry{
				ID:         stringRecordProp(gate, "id"),
				Type:       stringRecordProp(gate, "gate_type"),
				Status:     stringRecordProp(gate, "status"),
				SubjectRef: stringRecordProp(gate, "subject_ref"),
				Summary:    stringRecordProp(gate, "summary"),
				CanAccept:  canAcceptGate && boolRecordProp(gate, "can_accept"),
				CanReject:  canRejectGate && boolRecordProp(gate, "can_reject"),
			})
		}
		for _, digestAction := range recordSliceProp(orchestrationNode, "latest_digest_actions") {
			state.Orchestration.DigestActions = append(state.Orchestration.DigestActions, DigestActionEntry{
				ID:         stringRecordProp(digestAction, "id"),
				Kind:       stringRecordProp(digestAction, "kind"),
				Label:      stringRecordProp(digestAction, "label"),
				TargetRef:  stringRecordProp(digestAction, "target_ref"),
				ActionPath: stringRecordProp(digestAction, "action_path"),
				ActionName: stringRecordProp(digestAction, "action_name"),
				Urgency:    stringRecordProp(digestAction, "urgency"),
				CanRun:     canRunDigestAction,
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

func intProp(node *slop.WireNode, key string) int {
	value, ok := numberProp(node, key)
	if !ok {
		return 0
	}
	return int(value)
}

func recordSliceProp(node *slop.WireNode, key string) []map[string]any {
	if node == nil || node.Properties == nil {
		return nil
	}

	value, ok := node.Properties[key]
	if !ok {
		return nil
	}

	switch records := value.(type) {
	case []map[string]any:
		return records
	case []any:
		out := make([]map[string]any, 0, len(records))
		for _, item := range records {
			if record, ok := item.(map[string]any); ok {
				out = append(out, record)
			}
		}
		return out
	default:
		return nil
	}
}

func stringRecordProp(record map[string]any, key string) string {
	value, ok := record[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprintf("%v", value)
}

func boolRecordProp(record map[string]any, key string) bool {
	value, ok := record[key]
	if !ok {
		return false
	}
	boolean, ok := value.(bool)
	return ok && boolean
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
