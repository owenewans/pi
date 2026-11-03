<!--
Назначение: описание и параметры инструмента ssh_tunnel, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_tunnel

## описание

Открыть, показать или закрыть принадлежащие сессии локальные, удалённые или динамические SOCKS-пробросы SSH. list/close не требуют host; open требует host, type и bindPort; local/remote также требуют destinationHost и destinationPort. bindHost по умолчанию 127.0.0.1. Закрыть можно только пробросы этой сессии; при завершении сессии закрываются все.

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
          "const": "open"
        },
        {
          "type": "string",
          "const": "list"
        },
        {
          "type": "string",
          "const": "close"
        }
      ]
    },
    "host": {
      "type": "string"
    },
    "port": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "id": {
      "type": "string"
    },
    "type": {
      "anyOf": [
        {
          "type": "string",
          "const": "local"
        },
        {
          "type": "string",
          "const": "remote"
        },
        {
          "type": "string",
          "const": "dynamic"
        }
      ]
    },
    "bindHost": {
      "type": "string"
    },
    "bindPort": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "destinationHost": {
      "type": "string"
    },
    "destinationPort": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    }
  }
}
```
