---
name: attached-repositories
description: Investigate repositories supplied as implementation or design references.
---

Clone linked repositories into a task-specific directory under `/tmp`. Keep reference checkouts separate from the target and installed applications. Record revisions when behavior depends on a version. Do not run their installers or lifecycle scripts merely to inspect them.

Read the relevant implementation, tests and licenses. Compare concrete behavior with the target before choosing what to reuse. A feature list or screenshot does not establish how a feature works. Preserve required attribution when copying code.

For a non-Git fork, compare its files with the identified upstream revision. Do not restore intentionally removed docs, examples or infrastructure while importing source changes. Never delete the target's Git metadata unless explicitly requested.

Modify the target only. Keep temporary clones out of its diff. Report unavailable sources and unverified behavior.
