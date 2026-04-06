package session

import (
	"context"
	"fmt"
	"strings"
	"sync"

	slop "github.com/devteapot/slop/packages/go/slop-ai"
)

type Manager struct {
	consumer *slop.Consumer
	address  string
	subID    string
	updates  chan struct{}

	mu       sync.RWMutex
	tree     *slop.WireNode
	lastErr  error
	lastInfo string
}

func NewManager() *Manager {
	return &Manager{}
}

func (m *Manager) Connect(ctx context.Context, address string) error {
	m.Disconnect()

	transport := transportForAddress(address)
	if transport == nil {
		return fmt.Errorf("unsupported address: %s", address)
	}

	consumer := slop.NewConsumer(transport)
	hello, err := consumer.Connect(ctx)
	if err != nil {
		return fmt.Errorf("connect failed: %w", err)
	}

	m.mu.Lock()
	m.address = address
	m.consumer = consumer
	m.updates = make(chan struct{}, 1)
	m.lastInfo = providerNameFromHello(hello)
	m.lastErr = nil
	m.tree = nil
	m.subID = ""
	m.mu.Unlock()

	consumer.OnPatch(func(subID string, _ []slop.PatchOp, _ int) {
		tree := consumer.Tree(subID)
		if tree == nil {
			return
		}

		m.mu.Lock()
		if m.subID != "" && subID != m.subID {
			m.mu.Unlock()
			return
		}
		m.tree = tree
		m.mu.Unlock()
		m.notifyUpdate()
	})

	consumer.OnError(func(_ string, message string) {
		m.mu.Lock()
		m.lastErr = fmt.Errorf("%s", message)
		m.mu.Unlock()
		m.notifyUpdate()
	})

	consumer.OnDisconnect(func() {
		m.mu.Lock()
		m.consumer = nil
		m.lastErr = fmt.Errorf("disconnected")
		m.mu.Unlock()
		m.notifyUpdate()
	})

	subID, tree, err := consumer.Subscribe(ctx, "/", -1)
	if err != nil {
		consumer.Disconnect()
		m.mu.Lock()
		updates := m.updates
		m.consumer = nil
		m.updates = nil
		m.address = ""
		m.lastInfo = ""
		m.tree = nil
		m.subID = ""
		m.mu.Unlock()
		if updates != nil {
			close(updates)
		}
		return fmt.Errorf("subscribe failed: %w", err)
	}

	m.mu.Lock()
	m.subID = subID
	m.tree = &tree
	m.lastErr = nil
	m.mu.Unlock()
	m.notifyUpdate()
	return nil
}

func (m *Manager) Disconnect() {
	m.mu.Lock()
	consumer := m.consumer
	updates := m.updates

	m.consumer = nil
	m.updates = nil
	m.tree = nil
	m.subID = ""
	m.address = ""
	m.lastErr = nil
	m.lastInfo = ""
	m.mu.Unlock()

	if consumer != nil {
		consumer.Disconnect()
	}
	if updates != nil {
		close(updates)
	}
}

func (m *Manager) SendMessage(ctx context.Context, text string) error {
	m.mu.RLock()
	consumer := m.consumer
	m.mu.RUnlock()

	if consumer == nil {
		return fmt.Errorf("not connected")
	}

	_, err := consumer.Invoke(ctx, "/composer", "send_message", slop.Params{"text": text})
	return err
}

func (m *Manager) ApproveApproval(ctx context.Context, approvalID string) error {
	return m.invoke(ctx, fmt.Sprintf("/approvals/%s", approvalID), "approve", slop.Params{})
}

func (m *Manager) RejectApproval(ctx context.Context, approvalID string, reason string) error {
	params := slop.Params{}
	if trimmed := strings.TrimSpace(reason); trimmed != "" {
		params["reason"] = trimmed
	}

	return m.invoke(ctx, fmt.Sprintf("/approvals/%s", approvalID), "reject", params)
}

func (m *Manager) CancelTask(ctx context.Context, taskID string) error {
	return m.invoke(ctx, fmt.Sprintf("/tasks/%s", taskID), "cancel", slop.Params{})
}

func (m *Manager) CancelTurn(ctx context.Context) error {
	return m.invoke(ctx, "/turn", "cancel_turn", slop.Params{})
}

func (m *Manager) Snapshot() (*slop.WireNode, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tree, m.lastErr
}

func (m *Manager) Updates() <-chan struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.updates
}

func (m *Manager) ProviderInfo() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lastInfo
}

func (m *Manager) invoke(ctx context.Context, path string, action string, params slop.Params) error {
	m.mu.RLock()
	consumer := m.consumer
	m.mu.RUnlock()

	if consumer == nil {
		return fmt.Errorf("not connected")
	}

	_, err := consumer.Invoke(ctx, path, action, params)
	return err
}

func (m *Manager) notifyUpdate() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.updates == nil {
		return
	}

	select {
	case m.updates <- struct{}{}:
	default:
	}
}

func transportForAddress(address string) slop.ClientTransport {
	if strings.HasPrefix(address, "ws://") || strings.HasPrefix(address, "wss://") {
		return &slop.WSClientTransport{URL: address}
	}

	if strings.HasPrefix(address, "/") || strings.HasPrefix(address, ".") {
		return &slop.UnixClientTransport{Path: address}
	}

	return nil
}

func providerNameFromHello(hello map[string]any) string {
	provider, ok := hello["provider"].(map[string]any)
	if !ok {
		return ""
	}

	name, _ := provider["name"].(string)
	return name
}
