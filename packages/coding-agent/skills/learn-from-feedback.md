---
name: learn-from-feedback
description: Apply and retain explicit user corrections, workflow preferences, and repository-specific conventions. Use when a user corrects the agent or changes how work should be done, and at the start of later tasks to reuse saved guidance.
---

# Learn from feedback

When the user corrects a choice, process, or response style, fix the current work first. Then keep a concise reusable lesson in the user's agent directory at `experiences.md` (`$PI_CODING_AGENT_DIR/experiences.md`, or `~/.pi/agent/experiences.md` when unset). Read the file before starting a task when it exists.

Record clear, durable guidance, not every instruction. Generalize repeated corrections; keep one-off task facts in the task context. Separate user-wide preferences from repository-specific conventions. Do not store credentials, private content, or sensitive personal details. Merge duplicates and remove obsolete lessons when the user changes their preference.

Do not ask permission to record an ordinary workflow correction. Do not interrupt the task to announce the update. Apply the correction, update the file, and continue. If the intended rule is ambiguous or conflicts with another saved rule, ask only when the ambiguity changes what work is correct.
