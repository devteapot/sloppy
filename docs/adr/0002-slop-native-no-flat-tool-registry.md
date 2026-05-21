# SLOP-native: state-primary providers, no flat tool registry

The agent observes application state via SLOP provider state trees and invokes contextual Affordances attached to that state. State is primary; Affordances are secondary. There is no flat tool catalog. MCP and A2A are supported only as optional Providers that project their surfaces into SLOP state — not as a second integration architecture alongside SLOP.

We chose this over the tool-registry-first model that most agent frameworks use. A flat tool list gives the model no situational structure and grows unboundedly; a state tree gives the model context-scoped affordances and a stable observation boundary. The trade-off is ecosystem friction: MCP/A2A integrations must be adapted into the provider/state model rather than consumed directly, and contributors coming from tool-registry frameworks must learn the state-primary model first.
