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

	mu       sync.RWMutex
	tree     *slop.WireNode
	lastErr  error
	lastInfo string
}

func NewManager() *Manager {
	return &Manager{}
}

func (m *Manager) Connect(ctx context.Context, address string) error {
	transport := transportForAddress(address)
	if transport == nil {
		return fmt.Errorf("unsupported address: %s", address)
	}

	consumer := slop.NewConsumer(transport)
	hello, err := consumer.Connect(ctx)
	if err != nil {
		return fmt.Errorf("connect failed: %w", err)
	}

	m.address = address
	m.consumer = consumer
	m.lastInfo = providerNameFromHello(hello)
	m.lastErr = nil

	consumer.OnPatch(func(subID string, _ []slop.PatchOp, _ int) {
		tree := consumer.Tree(subID)
		if tree == nil {
			return
		}

		m.mu.Lock()
		m.tree = tree
		m.mu.Unlock()
	})

	consumer.OnError(func(_ string, message string) {
		m.mu.Lock()
		m.lastErr = fmt.Errorf("%s", message)
		m.mu.Unlock()
	})

	consumer.OnDisconnect(func() {
		m.mu.Lock()
		m.lastErr = fmt.Errorf("disconnected")
		m.mu.Unlock()
	})

	subID, tree, err := consumer.Subscribe(ctx, "/", -1)
	if err != nil {
		consumer.Disconnect()
		m.consumer = nil
		return fmt.Errorf("subscribe failed: %w", err)
	}

	m.mu.Lock()
	m.subID = subID
	m.tree = &tree
	m.mu.Unlock()
	return nil
}

func (m *Manager) Disconnect() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.consumer != nil {
		m.consumer.Disconnect()
	}
	m.consumer = nil
	m.tree = nil
	m.subID = ""
	m.address = ""
	m.lastErr = nil
	m.lastInfo = ""
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

func (m *Manager) Snapshot() (*slop.WireNode, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tree, m.lastErr
}

func (m *Manager) ProviderInfo() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lastInfo
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
