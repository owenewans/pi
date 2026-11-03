<!--
Назначение: описание и параметры инструмента ssh_read, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_read

## описание

Прочитать удалённый текстовый файл или показать удалённый каталог. Пути разрешаются относительно каталога входа на удалённой машине. По умолчанию выводится 2000 строк.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "path"
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
    "offset": {
      "type": "integer",
      "minimum": 1
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    }
  }
}
```
