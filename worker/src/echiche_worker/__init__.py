"""Echiche AI orchestration worker.

Owns run execution per ADR-001: claiming queued runs from PostgreSQL, the run state
machine, budgets, model/research adapters, critic/verifier, synthesis and memory
proposals. Communicates with the TypeScript web app only through database rows and
versioned JSON contracts in ``contracts/``.

M4 status: durable runs (M3) plus a model-backed reasoning provider (OpenAI adapter,
prompt registry, structured outputs, spend caps); research arrives in M5.
"""

__version__ = "0.4.0"
