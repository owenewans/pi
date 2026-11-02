---
name: commit
description: Prepare a requested commit using the repository's message style.
---

Read recent commits, the staged diff and the working tree. Follow the repository's commit style. Prefer a short, logical message; add a body only when it explains something the subject and diff do not. Avoid redundant summaries and unnecessary fragmentation into many tiny commits.
For a new repository, use a concise, lowercase, single-line English message without prefixes, scopes, quotes, Markdown or trailing punctuation. The first commit is `first commit`.

Run relevant checks on the final changes. Stage explicit paths from this task and inspect them again before committing. Preserve unrelated staged and unstaged work; do not include it, unstage it or rewrite it merely to simplify your commit. If it prevents an isolated commit, ask.

Treat committing, pushing, publishing and rewriting history as separate permissions. Commit only when requested. A progress message, punctuation-only reply, goal continuation or commit request from a previous task is not fresh authorization. Preserve an explicit hold or review requirement until the user changes it. Do not push unless requested. Verify the resulting commit and working tree; report the hash and whether anything remains uncommitted.
