---
name: readme
description: Write readme.md matching owenewans's supplied project examples.
---

Use the filename `readme.md`. Match the author's own root readmes, such as owenclave, owensurf and snolc; inherited upstream and nested dependency readmes are not style references. Use English, lowercase section headings and this header:

```markdown
<div align="center">

# PROJECT

short factual description.

<a href="https://count.owenewans.org/OWNER/REPO?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/OWNER/REPO?theme=moebooru-h&notitle" alt="repository views"></a>

`language` `component` `platform`

</div>
```

Use the real repository identity. Keep capabilities together in `features` and build/install steps together in `install`. Keep `usage` about running the program; put feature-specific instructions and setup details in linked documentation. Include only sections the project needs.

Omit separate fork/version paragraphs, development/test sections and generic copyright or attribution summaries unless requested. A license link is enough. Keep reference material in existing documentation or man pages; follow `documentation.md` and `stop-slop.md`.
