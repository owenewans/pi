<!--
Назначение: описание и параметры инструмента ssh_grep, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_grep

## описание

Искать содержимое удалённых файлов через ripgrep. Шаблон является данными, а не shell-командой. Требует rg на удалённом хосте.

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
    },
    "glob": {
      "type": "string"
    }
  }
}
```
