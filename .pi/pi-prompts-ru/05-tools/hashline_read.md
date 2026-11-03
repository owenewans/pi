<!--
Назначение: описание и параметры инструмента hashline_read, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/code/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# hashline_read

## описание

Прочитать UTF-8 файл как якоря LINE:HASH|text для hashline_edit. Перечитай после изменений; устаревшие хеши отклоняются. Поддерживает постраничное чтение и сохраняет окончания строк.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "path"
  ],
  "properties": {
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
      "maximum": 2000
    }
  }
}
```
