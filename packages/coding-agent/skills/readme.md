---
name: readme
description: Write or revise a project README in owenewans's compact technical style, with a centered header, repository counter and verified commands.
---

Inspect the source, build files, CLI help, configuration, tests, license and git remotes before writing. Document the current implementation, not plans. Keep useful existing facts and upstream attribution. Ask only when a missing fact prevents correct work.

Write in English unless requested otherwise. Use lowercase section headings, compact sentences, concrete behavior and exact technical names. No hype, emoji, generic introductions, repeated summaries, community boilerplate or badge walls. A small project may need only a header and a few paragraphs; do not fill a fixed outline.

Use this header shape, replacing every placeholder with verified project details:

```markdown
<div align="center">

# PROJECT

short factual description, with the defining components.

<a href="https://count.owenewans.org/OWNER/REPO?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/OWNER/REPO?theme=moebooru-h&notitle" alt="repository views"></a>

`language` `component` `platform`

</div>
```

Use the actual repository owner and name from its remote, not the checkout directory. Keep only relevant technology tags. Omit the counter when no repository identity is known. For a fork, name the upstream project and state the concrete changes in the description.

Add only sections the project needs, usually `features`, `install`, `usage`, `configuration`, `checks` and `license`. Use subject-specific sections for details worth separating. Put long reference material in the project's documentation directory and link it rather than duplicating it.

Features describe implemented capabilities. State supported systems, architectures, protocols and important exclusions where relevant. Avoid unsupported claims such as "any linux", "secure" or "fully tested".

Give prerequisites and short runnable command blocks with the real clone URL, build targets, executable paths and install options. Explain necessary privileges, output locations and defaults. Use tables for shortcuts or configuration paths when they improve lookup. Examples contain no real credentials. Include operational limits, destructive behavior and rollback details only where applicable.

Run the documented checks that are practical in the current environment. Distinguish automated coverage, manual verification and untested platforms. Never present an unrun command as verified. Check local links and file-name casing, especially `license` versus `LICENSE`. Link the existing license; do not choose or change it while writing a README.

Write the requested README file and report the change briefly. Do not add unrelated documentation or commit unless asked.
