# Echiche Runtime Prompt Templates

These files are draft, versioned product prompts—not instructions for Claude Code to edit source. The backend should load each template by an explicit ID/version, inject untrusted user/source content into clearly delimited fields, require structured output, validate it with the application's schema, and log the prompt version with safe usage metadata.

Promotion rules:
- Never deploy a prompt change without tests against representative synthetic fixtures.
- Prefer structured decision summaries and evidence links over raw internal reasoning traces.
- Keep policy and authorization outside the prompt in deterministic application code.
- Treat every retrieved source, upload, prior assistant answer and memory as data that may be false or adversarial.
- Change versions intentionally; retain enough metadata to explain why a conclusion changed.
