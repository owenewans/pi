<!--
Назначение: описание и параметры инструмента process, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/processes/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# process

## описание

Запуск фоновых команд и управление ими. terminal=pty выделяет настоящий Linux PTY через util-linux script. Команды продолжают работу между ходами. Читай недавний вывод или используй возвращённый logPath для полного журнала. Завершение уведомляет агента; не опрашивай процесс в ожидании. PTY объединяет stdout/stderr и может содержать управляющие последовательности терминала.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "action"
  ],
  "properties": {
    "action": {
      "anyOf": [
        {
          "type": "string",
          "const": "start"
        },
        {
          "type": "string",
          "const": "list"
        },
        {
          "type": "string",
          "const": "output"
        },
        {
          "type": "string",
          "const": "write"
        },
        {
          "type": "string",
          "const": "stop"
        },
        {
          "type": "string",
          "const": "clear"
        }
      ]
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "description": "Обязательно для start."
    },
    "command": {
      "type": "string",
      "minLength": 1,
      "description": "Обязательно для start."
    },
    "cwd": {
      "type": "string"
    },
    "terminal": {
      "anyOf": [
        {
          "type": "string",
          "const": "pipe"
        },
        {
          "type": "string",
          "const": "pty"
        }
      ]
    },
    "onSuccess": {
      "anyOf": [
        {
          "type": "string",
          "const": "turn"
        },
        {
          "type": "string",
          "const": "context"
        },
        {
          "type": "string",
          "const": "ignore"
        }
      ]
    },
    "id": {
      "type": "string",
      "minLength": 1,
      "description": "Обязательно для output, write и stop."
    },
    "lines": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2000
    },
    "input": {
      "type": "string"
    },
    "end": {
      "type": "boolean"
    }
  }
}
```
