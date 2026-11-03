<!--
Назначение: описание и параметры инструмента ssh_write, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_write

## описание

Атомарно записать удалённый UTF-8 файл, создав родительские каталоги и сохранив права существующего файла.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "path",
    "content"
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
    "content": {
      "type": "string"
    }
  }
}
```
