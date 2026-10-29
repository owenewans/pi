# Zed context

Pi reads Zed's local SQLite state with the `sqlite3` executable. It selects the workspace containing the current working directory and exposes the active file, open files and selected lines through `zed_current_context`, `zed_open_files` and `zed_selected_lines`. The current selection is included as untrusted context when a turn starts. Interactive sessions show the active file above the editor.

The default database is `~/.local/share/zed/db/0-stable/db.sqlite`. Set `PI_ZED_DB` to use a different database. If the database, executable or expected schema is unavailable, the tools report the reason and pi continues normally.

This context integration does not provide an ACP endpoint. ACP is tracked separately.

Derived from [pi-zed](https://github.com/ravshansbox/pi-zed), revision `f982f8b1afb0951619d531bc3699b8b3f204dec6`; its license is in `licenses/pi-zed.txt`.
