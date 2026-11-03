<!--
Назначение: описание и параметры инструмента ssh_glob, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_glob

## описание

Находить удалённые файлы по glob через ripgrep с учётом файлов игнорирования. Требует rg на удалённом хосте.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "pattern"
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
    "pattern": {
      "type": "string"
    },
    "path": {
      "type": "string"
    }
  }
}
```
