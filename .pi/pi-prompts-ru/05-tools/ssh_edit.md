<!--
Назначение: описание и параметры инструмента ssh_edit, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_edit

## описание

Заменить одно уникальное точное совпадение в удалённом UTF-8 файле. Отказывается перезаписывать файл, изменившийся после чтения этой операцией.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "path",
    "oldText",
    "newText"
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
    "path": {
      "type": "string",
      "minLength": 1
    },
    "oldText": {
      "type": "string",
      "minLength": 1
    },
    "newText": {
      "type": "string"
    }
  }
}
```
