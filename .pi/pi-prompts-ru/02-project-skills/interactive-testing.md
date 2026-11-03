<!--
Назначение: навык проверки интерактивного режима pi в управляемом терминале tmux.
Источник: /home/owenewans/Projects/lunera/pi/.pi/skills/interactive-testing.md
Статус: русская копия для правки, не используется Pi.
-->
---
name: interactive-testing
description: Проверка и отладка интерактивного режима pi в управляемом терминале tmux. Используйте для проверок поведения TUI и интерактивных дымовых тестов релиза.
---

# Проверка интерактивного режима pi с помощью tmux

Запустите TUI в управляемом терминале (из корня репозитория, на два каталога выше исходного файла этого навыка):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./scripts/pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

Смысл английского текста в сохранённом примере: `capture after startup` означает «снять содержимое панели после запуска»; `your prompt here` означает «ваш промпт здесь»; `special keys (also C-o for ctrl+o, etc.)` означает «специальные клавиши (также C-o для ctrl+o и т. д.)».

Для дымовых тестов релиза запускайте сеанс tmux с `-c /tmp` и заменяйте `./scripts/pi-test.sh` абсолютным путём к исполняемому файлу релиза. Проверяйте исполняемые файлы Node и Bun отдельно, отправляйте промпт и дожидайтесь ответа модели; один лишь запуск не означает успешного прохождения дымового теста.
