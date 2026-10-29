# Debugger

The `debugger` tool owns one local GDB machine-interface session. Install `gdb` and compile the target with debug symbols, for example `cc -g -O0 main.c -o main`.

1. Start with `action: start`, `program: ./main` and optional literal `args`.
2. Send `action: command`, `command: -break-insert main`, then `-exec-run`.
3. Use `action: read` until a `*stopped` event arrives. Inspect with commands such as `-stack-list-frames` or `-data-evaluate-expression x`.
4. Continue with `-exec-continue`, or use `action: close` to stop the inferior and GDB.

GDB processes events asynchronously; a `^running` response is not a stop event. The tool bounds retained output and returns the raw machine-interface records. Cancelling a command stops waiting for its response; it does not stop the inferior. Session shutdown closes the debugger.
