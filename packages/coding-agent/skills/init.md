---
name: init
description: Initialize a project and create its GitHub or Codeberg repository.
---

Inspect the directory. Ask for missing choices: license, hosting, repository name and visibility. Suggest Unlicense; keep inherited licenses. Name the license file `license` unless the project uses another convention.

Add a suitable `.gitignore` and use `readme.md` for the README. Create the remote through `gh` or the Codeberg client, with a short English description, three relevant topics and any requested invitations.
