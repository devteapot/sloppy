# Lean kernel: orchestration lives in plugins, not core

The Kernel deliberately ships no orchestration DAG, scheduler, task lifecycle hooks, or self-repair playbooks. It provides only the Agent loop, the Hub, the Session provider/supervisor, provider discovery, the approval queue, and the plugin manager. Planning, delegation strategy, review loops, and task graphs are compositions over Providers, Plugins, and Skills — not kernel branches.

We chose this over the path most agent harnesses take (orchestration built into the core) because a hardcoded orchestrator role fixes one workflow shape into the runtime and is expensive to unwind later. Keeping the kernel lean means new capabilities are added as Plugins without touching core, and the runtime stays small. The cost: workflow features that a built-in orchestrator would give for free must be rebuilt as optional Plugins or Skills.
