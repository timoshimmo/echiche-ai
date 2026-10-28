"""Echiche AI orchestration worker.

Owns run execution per ADR-001: claiming queued runs from PostgreSQL, the run state
machine, budgets, model/research adapters, critic/verifier, synthesis and memory
proposals. Communicates with the TypeScript web app only through database rows and
versioned JSON contracts in ``contracts/``.

M5 status: durable runs (M3), a model-backed reasoning provider (M4), and research with
provenance: Brave discovery, pages fetched and read by the worker itself, claims tied to
exact quotes and independently verified (M5); project memory and proposals (M6).
"""

__version__ = "0.7.0"
