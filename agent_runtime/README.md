# Agent Runtime

`agent_runtime` is the provider-neutral execution layer.

The main flow is:

1. `core/agent_core.py` runs one agent turn and owns the tool loop.
2. `provider_factory.py` creates provider clients and adapters.
3. `adapters/` translate runtime state to provider requests and translate
   provider streams back into runtime events.
4. `core/stream_events.py`, `core/canonical_types.py`, and
   `core/transcript_contract.py` define stable product/runtime contracts.

This package should not know about desktop UI sessions, persisted settings, or
the product's local tool implementation.
