<!--
Назначение: описание и параметры инструмента subagent, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/subagents/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# subagent

## описание

Запускай фоновых субагентов и сразу получай ID, продолжая свою работу. Завершение автоматически доставляет результат и пробуждает родителя; не опрашивай в ожидании. action=list, result и stop позволяют посмотреть или отменить задачи; clear удаляет завершённые. Не больше четырёх агентов на сессию. Задачи должны быть самодостаточными: субагенты не видят разговор родителя. scout и reviewer имеют только инструменты чтения файлов; worker может читать, выполнять команды и редактировать. Все работают с одной файловой системой, поэтому назначай непересекающиеся изменения. Задачи переживают ходы и прерывания родителя, но останавливаются при смене ветки и завершении сессии.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
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
          "const": "result"
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
    "id": {
      "type": "string",
      "minLength": 1,
      "description": "Обязательно для result и stop."
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "role",
          "task"
        ],
        "properties": {
          "role": {
            "anyOf": [
              {
                "type": "string",
                "const": "scout"
              },
              {
                "type": "string",
                "const": "reviewer"
              },
              {
                "type": "string",
                "const": "worker"
              }
            ]
          },
          "task": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "minItems": 1,
      "maxItems": 4
    }
  }
}
```
