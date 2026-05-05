package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	slop "github.com/devteapot/slop/packages/go/slop-ai"
	"github.com/devteapot/sloppy/apps/tui/session"
)

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
	key := message.String()
	if key == "ctrl+c" {
		return a, tea.Quit
	}

	if a.leaderPending {
		return a.handleLeaderKey(message)
	}

	if !a.rejectPromptOpen() && a.sessionScreen != sessionScreenSettings && key == a.tuiSettings.Keybinds.Leader {
		a.leaderPending = true
		a.sessionErr = ""
		return a, nil
	}

	if a.rejectPromptOpen() {
		return a.updateRejectPrompt(message)
	}
	if a.sessionScreen == sessionScreenProfiles {
		return a.updateProfiles(message)
	}
	if a.sessionScreen == sessionScreenSettings {
		return a.updateSettings(message)
	}

	if isPaneNavigationKey(key) && a.moveMainPane(key) {
		a.syncInputs()
		return a, nil
	}

	if a.focus == paneComposer {
		switch key {
		case "esc":
			a.leaveToDiscovery()
			return a, discoverCmd()
		case "tab":
			a.focus = nextPane(a.focus)
			a.syncInputs()
			return a, nil
		case "shift+tab":
			a.focus = previousPane(a.focus)
			a.syncInputs()
			return a, nil
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

	switch key {
	case "esc":
		a.leaveToDiscovery()
		return a, discoverCmd()
	case "tab", "right":
		a.focus = nextPane(a.focus)
		a.syncInputs()
		return a, nil
	case "shift+tab", "left":
		a.focus = previousPane(a.focus)
		a.syncInputs()
		return a, nil
	case "up", "k":
		a.moveSelection(-1)
		return a, nil
	case "down", "j":
		a.moveSelection(1)
		return a, nil
	case "enter":
		switch a.focus {
		case paneApprovals:
			if approval := a.selectedApproval(); approval != nil && approval.CanApprove {
				return a, approveApprovalCmd(a.manager, approval.ID)
			}
		case paneOrchestration:
			if entry := a.selectedOrchestrationEntry(); entry != nil {
				if entry.Gate != nil && entry.Gate.CanAccept {
					return a, acceptOrchestrationGateCmd(a.manager, entry.Gate.ID)
				}
				if entry.Action != nil && entry.Action.CanRun {
					return a, runDigestActionCmd(a.manager, entry.Action.ID)
				}
			}
		case paneTasks:
			if task := a.selectedTask(); task != nil && task.CanCancel {
				return a, cancelTaskCmd(a.manager, task.ID)
			}
		}
	}

	return a, nil
}

func (a App) updateRejectPrompt(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch message.String() {
	case "esc":
		if a.rejectEditing {
			a.rejectEditing = false
			a.syncInputs()
			return a, nil
		}
		a.closeRejectPrompt()
		a.syncInputs()
		return a, nil
	case "enter":
		if !a.rejectEditing {
			a.rejectEditing = true
			a.syncInputs()
			return a, nil
		}

		approvalID := a.rejectApprovalID
		reason := strings.TrimSpace(a.rejectInput.Value())
		a.closeRejectPrompt()
		a.syncInputs()
		if approvalID == "" {
			return a, nil
		}
		return a, rejectApprovalCmd(a.manager, approvalID, reason)
	}

	if !a.rejectEditing {
		return a, nil
	}

	var cmd tea.Cmd
	a.rejectInput, cmd = a.rejectInput.Update(message)
	return a, cmd
}

func (a App) updateProfiles(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.profileFocus == profileForm && a.profileFieldEditing {
		switch message.String() {
		case "esc", "enter":
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
		}

		var cmd tea.Cmd
		switch a.profileFieldFocus {
		case 0:
			a.profileLabelInput, cmd = a.profileLabelInput.Update(message)
		case 1:
			a.profileProviderInput, cmd = a.profileProviderInput.Update(message)
		case 2:
			a.profileModelInput, cmd = a.profileModelInput.Update(message)
		case 3:
			a.profileBaseURLInput, cmd = a.profileBaseURLInput.Update(message)
		default:
			a.profileAPIKeyInput, cmd = a.profileAPIKeyInput.Update(message)
		}

		return a, cmd
	}

	switch message.String() {
	case "esc":
		if a.state.CanSendMessage {
			a.sessionScreen = sessionScreenMain
			a.focus = paneComposer
		} else {
			a.profileFocus = profileList
		}
		a.profileFieldEditing = false
		a.syncInputs()
		return a, nil
	case "tab":
		if a.profileFocus == profileForm {
			a.moveProfileField(1)
			a.syncInputs()
			return a, nil
		}
	case "shift+tab":
		if a.profileFocus == profileForm {
			a.moveProfileField(-1)
			a.syncInputs()
			return a, nil
		}
	case "left", "h":
		a.profileFocus = profileList
		a.profileFieldEditing = false
		a.syncInputs()
		return a, nil
	case "right", "l":
		a.profileFocus = profileForm
		a.profileFieldEditing = false
		if a.editingProfileID == "" {
			a.loadSelectedProfileIntoForm()
		}
		a.syncInputs()
		return a, nil
	}

	if a.profileFocus == profileList {
		switch message.String() {
		case "up", "k":
			if a.profileCursor > 0 {
				a.profileCursor--
			}
			return a, nil
		case "down", "j":
			if a.profileCursor < len(a.state.Profiles)-1 {
				a.profileCursor++
			}
			return a, nil
		case "enter":
			a.profileFocus = profileForm
			a.loadSelectedProfileIntoForm()
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
		}

		return a, nil
	}

	switch message.String() {
	case "up", "k":
		a.moveProfileField(-1)
		a.syncInputs()
		return a, nil
	case "down", "j":
		a.moveProfileField(1)
		a.syncInputs()
		return a, nil
	case "enter":
		a.profileFieldEditing = true
		a.syncInputs()
		return a, nil
	}

	return a, nil
}

func (a App) updateSettings(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if a.settingsCapturing {
		switch message.String() {
		case "esc":
			a.settingsCapturing = false
			a.sessionErr = ""
			return a, nil
		default:
			nextLeader := normalizeLeaderKey(message.String())
			if err := validateLeaderKey(nextLeader); err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}

			nextSettings := a.tuiSettings
			nextSettings.Keybinds.Leader = nextLeader
			if err := writeHomeTuiSettings(nextSettings); err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}

			a.tuiSettings = nextSettings
			a.settingsCapturing = false
			a.sessionErr = ""
			return a, nil
		}
	}

	switch message.String() {
	case "esc":
		a.sessionScreen = a.settingsReturnScreen
		if a.sessionScreen == "" {
			a.sessionScreen = sessionScreenMain
		}
		a.syncInputs()
		return a, nil
	case "enter":
		a.settingsCapturing = true
		a.sessionErr = ""
		return a, nil
	}

	return a, nil
}

func (a App) handleLeaderKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := message.String()
	a.leaderPending = false
	if key == "esc" || key == a.tuiSettings.Keybinds.Leader {
		return a, nil
	}

	if a.sessionScreen == sessionScreenProfiles {
		return a.handleProfileLeaderAction(key)
	}
	return a.handleMainLeaderAction(key)
}

func (a App) handleMainLeaderAction(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q":
		return a, tea.Quit
	case "p":
		a.openProfilesScreen()
		return a, nil
	case "s":
		a.openSettingsScreen(sessionScreenMain)
		return a, nil
	case "i":
		a.focus = paneComposer
		a.syncInputs()
		return a, nil
	case "t":
		if a.state.CanCancelTurn {
			return a, cancelTurnCmd(a.manager)
		}
	case "a":
		if approval := a.selectedApproval(); approval != nil && approval.CanApprove && a.focus == paneApprovals {
			return a, approveApprovalCmd(a.manager, approval.ID)
		}
		if entry := a.selectedOrchestrationEntry(); entry != nil && entry.Gate != nil && entry.Gate.CanAccept && a.focus == paneOrchestration {
			return a, acceptOrchestrationGateCmd(a.manager, entry.Gate.ID)
		}
	case "r":
		if approval := a.selectedApproval(); approval != nil && approval.CanReject && a.focus == paneApprovals {
			a.rejectApprovalID = approval.ID
			a.rejectInput.SetValue("")
			a.rejectEditing = false
			a.syncInputs()
			return a, nil
		}
		if entry := a.selectedOrchestrationEntry(); entry != nil && entry.Gate != nil && entry.Gate.CanReject && a.focus == paneOrchestration {
			return a, rejectOrchestrationGateCmd(a.manager, entry.Gate.ID)
		}
	case "d":
		if entry := a.selectedOrchestrationEntry(); entry != nil && entry.Action != nil && entry.Action.CanRun && a.focus == paneOrchestration {
			return a, runDigestActionCmd(a.manager, entry.Action.ID)
		}
	case "c":
		if task := a.selectedTask(); task != nil && task.CanCancel && a.focus == paneTasks {
			return a, cancelTaskCmd(a.manager, task.ID)
		}
	}
	return a, nil
}

func (a App) handleProfileLeaderAction(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q":
		return a, tea.Quit
	case "s":
		a.openSettingsScreen(sessionScreenProfiles)
		return a, nil
	case "w":
		if a.profileFocus == profileForm {
			params, err := a.profileSaveParams()
			if err != nil {
				a.sessionErr = err.Error()
				return a, nil
			}
			return a, saveProfileCmd(a.manager, params)
		}
	case "n":
		if a.profileFocus == profileList {
			a.startNewProfileForm()
			a.profileFocus = profileForm
			a.profileFieldEditing = false
			a.syncInputs()
			return a, nil
		}
	case "f":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil {
				return a, setDefaultProfileCmd(a.manager, profile.ID)
			}
		}
	case "d":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteProfile {
				return a, deleteProfileCmd(a.manager, profile.ID)
			}
		}
	case "x":
		if a.profileFocus == profileList {
			if profile := a.selectedProfile(); profile != nil && profile.CanDeleteAPIKey {
				return a, deleteAPIKeyCmd(a.manager, profile.ID)
			}
		}
	}

	return a, nil
}

func (a *App) openProfilesScreen() {
	a.sessionScreen = sessionScreenProfiles
	a.profileFocus = profileList
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.loadSelectedProfileIntoForm()
	a.syncInputs()
}

func (a *App) openSettingsScreen(returnScreen string) {
	a.settingsReturnScreen = returnScreen
	a.sessionScreen = sessionScreenSettings
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.syncInputs()
}

func (a *App) closeRejectPrompt() {
	a.rejectApprovalID = ""
	a.rejectInput.SetValue("")
	a.rejectEditing = false
}

func (a *App) leaveToDiscovery() {
	a.manager.Disconnect()
	a.state = session.ViewState{}
	a.address = ""
	a.mode = "discovery"
	a.leaderPending = false
	a.rejectApprovalID = ""
	a.rejectEditing = false
	a.profileFieldEditing = false
	a.settingsCapturing = false
	a.focus = paneComposer
	a.lastMainFocus = paneTranscript
	a.sessionScreen = sessionScreenMain
	a.settingsReturnScreen = sessionScreenMain
	a.transcriptPinned = true
	a.syncInputs()
}

func (a *App) moveProfileField(delta int) {
	a.profileFieldFocus += delta
	if a.profileFieldFocus < 0 {
		a.profileFieldFocus = 0
	}
	if a.profileFieldFocus > 4 {
		a.profileFieldFocus = 4
	}
	a.profileFieldEditing = false
}

func (a App) profileSaveParams() (slop.Params, error) {
	provider := strings.TrimSpace(a.profileProviderInput.Value())
	model := strings.TrimSpace(a.profileModelInput.Value())
	if provider == "" || model == "" {
		return nil, fmt.Errorf("provider and model are required")
	}

	params := slop.Params{
		"provider": provider,
		"model":    model,
	}
	if trimmed := strings.TrimSpace(a.profileLabelInput.Value()); trimmed != "" {
		params["label"] = trimmed
	}
	if trimmed := strings.TrimSpace(a.profileBaseURLInput.Value()); trimmed != "" {
		params["base_url"] = trimmed
	}
	if trimmed := strings.TrimSpace(a.profileAPIKeyInput.Value()); trimmed != "" {
		params["api_key"] = trimmed
	}
	if a.editingProfileID != "" {
		params["profile_id"] = a.editingProfileID
	}
	return params, nil
}

func (a *App) moveMainPane(key string) bool {
	order := []paneFocus{paneTranscript, paneApprovals, paneOrchestration, paneTasks, paneApps, paneActivity, paneComposer}
	if a.sessionBodyWidth() < 112 {
		index := 0
		for i := range order {
			if order[i] == a.focus {
				index = i
				break
			}
		}
		switch key {
		case "shift+up", "shift+left":
			if index > 0 {
				a.focus = order[index-1]
				return true
			}
		case "shift+down", "shift+right":
			if index < len(order)-1 {
				a.focus = order[index+1]
				return true
			}
		}
		return false
	}

	next := a.focus
	switch a.focus {
	case paneTranscript:
		switch key {
		case "shift+right":
			next = paneApprovals
		case "shift+down":
			next = paneComposer
		}
	case paneApprovals:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+down":
			next = paneOrchestration
		}
	case paneOrchestration:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneApprovals
		case "shift+down":
			next = paneTasks
		}
	case paneTasks:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneOrchestration
		case "shift+down":
			next = paneApps
		}
	case paneApps:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneTasks
		case "shift+down":
			next = paneActivity
		}
	case paneActivity:
		switch key {
		case "shift+left":
			next = paneTranscript
		case "shift+up":
			next = paneApps
		case "shift+down":
			next = paneComposer
		}
	case paneComposer:
		if key == "shift+up" {
			next = a.lastMainFocus
			if next == paneComposer {
				next = paneTranscript
			}
		}
	}

	if next == a.focus {
		return false
	}
	a.focus = next
	return true
}

func (a *App) syncInputs() {
	if a.sessionScreen == sessionScreenMain && !a.rejectPromptOpen() && a.focus != paneComposer {
		a.lastMainFocus = a.focus
	}

	if a.rejectPromptOpen() {
		a.blurProfileInputs()
		if a.rejectEditing {
			a.rejectInput.Focus()
		} else {
			a.rejectInput.Blur()
		}
		a.input.Blur()
		return
	}

	a.rejectInput.Blur()
	if a.sessionScreen == sessionScreenProfiles {
		a.input.Blur()
		if a.profileFocus != profileForm || !a.profileFieldEditing {
			a.blurProfileInputs()
			return
		}

		a.blurProfileInputs()
		switch a.profileFieldFocus {
		case 0:
			a.profileLabelInput.Focus()
		case 1:
			a.profileProviderInput.Focus()
		case 2:
			a.profileModelInput.Focus()
		case 3:
			a.profileBaseURLInput.Focus()
		default:
			a.profileAPIKeyInput.Focus()
		}
		return
	}
	if a.sessionScreen == sessionScreenSettings {
		a.blurProfileInputs()
		a.input.Blur()
		return
	}

	a.blurProfileInputs()
	if a.focus == paneComposer {
		a.input.Focus()
	} else {
		a.input.Blur()
	}
}

func (a *App) blurProfileInputs() {
	a.profileLabelInput.Blur()
	a.profileProviderInput.Blur()
	a.profileModelInput.Blur()
	a.profileBaseURLInput.Blur()
	a.profileAPIKeyInput.Blur()
}

func (a *App) moveSelection(delta int) {
	switch a.focus {
	case paneTranscript:
		a.transcriptCursor = clampRange(a.transcriptCursor+delta, len(a.state.Transcript))
		a.transcriptPinned = a.transcriptCursor >= len(a.state.Transcript)-1
	case paneApprovals:
		a.approvalCursor = clampRange(a.approvalCursor+delta, len(a.state.Approvals))
	case paneOrchestration:
		a.orchestrationCursor = clampRange(a.orchestrationCursor+delta, a.orchestrationEntryCount())
	case paneTasks:
		a.taskCursor = clampRange(a.taskCursor+delta, len(a.state.Tasks))
	case paneApps:
		a.appCursor = clampRange(a.appCursor+delta, len(a.state.Apps))
	case paneActivity:
		a.activityCursor = clampRange(a.activityCursor+delta, len(a.state.Activity))
	}
}

func (a App) selectedApproval() *session.ApprovalEntry {
	if len(a.state.Approvals) == 0 {
		return nil
	}
	index := clampRange(a.approvalCursor, len(a.state.Approvals))
	return &a.state.Approvals[index]
}

func (a App) selectedApprovalByID(id string) *session.ApprovalEntry {
	if id == "" {
		return nil
	}
	for index := range a.state.Approvals {
		if a.state.Approvals[index].ID == id {
			return &a.state.Approvals[index]
		}
	}
	return nil
}

func (a App) selectedTask() *session.TaskEntry {
	if len(a.state.Tasks) == 0 {
		return nil
	}
	index := clampRange(a.taskCursor, len(a.state.Tasks))
	return &a.state.Tasks[index]
}

func (a App) orchestrationEntries() []orchestrationListEntry {
	entries := make([]orchestrationListEntry, 0, len(a.state.Orchestration.Gates)+len(a.state.Orchestration.DigestActions))
	for index := range a.state.Orchestration.Gates {
		entries = append(entries, orchestrationListEntry{Gate: &a.state.Orchestration.Gates[index]})
	}
	for index := range a.state.Orchestration.DigestActions {
		entries = append(entries, orchestrationListEntry{Action: &a.state.Orchestration.DigestActions[index]})
	}
	return entries
}

func (a App) orchestrationEntryCount() int {
	return len(a.state.Orchestration.Gates) + len(a.state.Orchestration.DigestActions)
}

func (a App) selectedOrchestrationEntry() *orchestrationListEntry {
	entries := a.orchestrationEntries()
	if len(entries) == 0 {
		return nil
	}
	index := clampRange(a.orchestrationCursor, len(entries))
	return &entries[index]
}

func (a App) selectedProfile() *session.LlmProfileEntry {
	if len(a.state.Profiles) == 0 {
		return nil
	}
	index := clampRange(a.profileCursor, len(a.state.Profiles))
	return &a.state.Profiles[index]
}

func (a App) selectedProfileByID(id string) *session.LlmProfileEntry {
	if id == "" {
		return nil
	}
	for index := range a.state.Profiles {
		if a.state.Profiles[index].ID == id {
			return &a.state.Profiles[index]
		}
	}
	return nil
}

func (a *App) loadSelectedProfileIntoForm() {
	if profile := a.selectedProfile(); profile != nil {
		if profile.Managed {
			a.editingProfileID = profile.ID
		} else {
			a.editingProfileID = ""
		}
		a.profileFieldFocus = 0
		label := profile.Label
		if profile.Origin == "environment" && profile.APIKeyEnv != "" {
			label = strings.TrimSuffix(label, fmt.Sprintf(" (%s)", profile.APIKeyEnv))
		}
		a.profileLabelInput.SetValue(label)
		a.profileProviderInput.SetValue(profile.Provider)
		a.profileModelInput.SetValue(profile.Model)
		a.profileBaseURLInput.SetValue(profile.BaseURL)
		a.profileAPIKeyInput.SetValue("")
		return
	}

	a.startNewProfileForm()
}

func (a *App) startNewProfileForm() {
	a.editingProfileID = ""
	a.profileFieldFocus = 0
	a.profileLabelInput.SetValue("")
	if a.state.LlmStatus == "ready" && len(a.state.Profiles) > 0 {
		if profile := a.selectedProfile(); profile != nil {
			a.profileProviderInput.SetValue(profile.Provider)
			a.profileModelInput.SetValue(profile.Model)
			a.profileBaseURLInput.SetValue(profile.BaseURL)
		} else {
			a.profileProviderInput.SetValue("")
			a.profileModelInput.SetValue("")
			a.profileBaseURLInput.SetValue("")
		}
	} else {
		a.profileProviderInput.SetValue("")
		a.profileModelInput.SetValue("")
		a.profileBaseURLInput.SetValue("")
	}
	a.profileAPIKeyInput.SetValue("")
}

func (a App) rejectPromptOpen() bool {
	return a.rejectApprovalID != ""
}

func (a App) applyViewStateFromManager() App {
	tree, err := a.manager.Snapshot()
	return a.applyViewState(session.BuildView(tree, err))
}

func (a App) applyViewState(next session.ViewState) App {
	previous := a.state
	a.state = next

	// Transcript uses pinned auto-follow instead of preserveCursor.
	if a.transcriptPinned {
		a.transcriptCursor = maxInt(len(next.Transcript)-1, 0)
	} else {
		a.transcriptCursor = clampIndex(a.transcriptCursor, len(next.Transcript))
	}

	a.approvalCursor = preserveCursor(len(previous.Approvals), len(next.Approvals), a.approvalCursor)
	a.orchestrationCursor = preserveCursor(
		len(previous.Orchestration.Gates)+len(previous.Orchestration.DigestActions),
		len(next.Orchestration.Gates)+len(next.Orchestration.DigestActions),
		a.orchestrationCursor,
	)
	a.taskCursor = preserveCursor(len(previous.Tasks), len(next.Tasks), a.taskCursor)
	a.appCursor = preserveCursor(len(previous.Apps), len(next.Apps), a.appCursor)
	a.activityCursor = preserveCursor(len(previous.Activity), len(next.Activity), a.activityCursor)
	a.profileCursor = preserveCursor(len(previous.Profiles), len(next.Profiles), a.profileCursor)

	if !hasPendingApprovals(previous.Approvals) && hasPendingApprovals(next.Approvals) && !a.rejectPromptOpen() {
		if pendingIndex := firstPendingApprovalIndex(next.Approvals); pendingIndex >= 0 {
			a.approvalCursor = pendingIndex
		}
		if strings.TrimSpace(a.input.Value()) == "" || a.focus != paneComposer {
			a.focus = paneApprovals
		}
	}
	if !hasPendingOrchestrationGates(previous.Orchestration.Gates) && hasPendingOrchestrationGates(next.Orchestration.Gates) && !a.rejectPromptOpen() {
		a.orchestrationCursor = 0
		if strings.TrimSpace(a.input.Value()) == "" || a.focus != paneComposer {
			a.focus = paneOrchestration
		}
	}

	if (!next.CanSendMessage || next.LlmStatus != "ready") && a.sessionScreen == sessionScreenMain {
		a.sessionScreen = sessionScreenProfiles
	}
	if a.sessionScreen == sessionScreenProfiles {
		if a.editingProfileID == "" {
			a.loadSelectedProfileIntoForm()
		} else if profile := a.selectedProfileByID(a.editingProfileID); profile != nil {
			a.profileLabelInput.SetValue(profile.Label)
			a.profileProviderInput.SetValue(profile.Provider)
			a.profileModelInput.SetValue(profile.Model)
			a.profileBaseURLInput.SetValue(profile.BaseURL)
		} else {
			a.startNewProfileForm()
		}
	}

	a.syncInputs()
	return a
}
