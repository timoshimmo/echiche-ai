"""Echiche AI orchestration worker.

Owns run execution per ADR-001: claiming queued runs from PostgreSQL, the run state
machine, budgets, model/research adapters, critic/verifier, synthesis and memory
proposals. Communicates with the TypeScript web app only through database rows and
versioned JSON contracts in ``contracts/``.

M1 status: skeleton only (configuration validation and structured logging).
"""

__version__ = "0.3.0"
