---
name: init
description: Initialize a project, choose its license and create a GitHub or Codeberg repository.
---

Inspect the directory first. Preserve existing code and metadata.
Ask together for missing decisions: license, GitHub or Codeberg, repository name and visibility. For a private repository, ask whom to invite; an empty list is valid.

Never choose a license without asking unless the user explicitly delegates that decision. Suggest Unlicense by default. Explain GPL when the user wants derivatives to stay open; do not prefer MIT or BSD automatically. Keep inherited licenses and notices intact. Name the license file `license` unless the project requires another path.

Write `.gitignore` for the actual language and build outputs, without comments or unrelated templates. Create only the requested files. A README states purpose, working commands and actual limitations; omit badges, filler and unimplemented features unless requested.

Test the starting project. When an initial commit is authorized, include the license, README, ignore rules and relevant starting code; use `first commit`.

Create the remote with the chosen visibility, a short factual English description and three relevant topics. Use `gh` for GitHub and the available Codeberg client or API for Codeberg. Apply requested invitations. Verify the URL and visibility. Never claim publication succeeded without checking the remote.
