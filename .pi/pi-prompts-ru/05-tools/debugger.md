<!--
Назначение: описание и параметры инструмента debugger, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/code/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# debugger

## описание

Постоянная локальная сессия GDB machine-interface. action=start открывает скомпилированную программу с буквальными аргументами; command отправляет одну GDB MI команду, read получает асинхронные события остановки и вывод программы, close завершает отладчик и программу. Пример: -break-insert main, -exec-run, read до *stopped, -stack-list-frames, -data-evaluate-expression x. Требует gdb и отладочные символы. Отмена команды прекращает ожидание, но не отлаживаемую программу.

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
          "const": "command"
        },
        {
          "type": "string",
          "const": "read"
        },
        {
          "type": "string",
          "const": "close"
        }
      ]
    },
    "program": {
      "type": "string",
      "minLength": 1
    },
    "args": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "command": {
      "type": "string",
      "minLength": 1
    }
  }
}
```
