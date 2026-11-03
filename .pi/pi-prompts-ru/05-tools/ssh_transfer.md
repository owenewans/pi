<!--
Назначение: описание и параметры инструмента ssh_transfer, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_transfer

## описание

Копирование файла или каталога между этой машиной и SSH-хостом через бинарные потоки архива. Требует tar и GNU mv на обоих Linux-хостах. Пути задают точное назначение, а не каталоги-контейнеры. Для каталогов обязателен recursive. Существующее назначение сохраняется, если overwrite не true; непустые каталоги никогда не объединяются. Использует псевдонимы SSH config, ключи и переходы; интерактивных паролей нет.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "direction",
    "localPath",
    "remotePath"
  ],
  "properties": {
    "host": {
      "type": "string",
      "minLength": 1
    },
    "port": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "direction": {
      "anyOf": [
        {
          "type": "string",
          "const": "upload"
        },
        {
          "type": "string",
          "const": "download"
        }
      ]
    },
    "localPath": {
      "type": "string",
      "minLength": 1
    },
    "remotePath": {
      "type": "string",
      "minLength": 1
    },
    "recursive": {
      "type": "boolean"
    },
    "overwrite": {
      "type": "boolean"
    },
    "timeout": {
      "type": "integer",
      "minimum": 1,
      "maximum": 3600
    }
  }
}
```
