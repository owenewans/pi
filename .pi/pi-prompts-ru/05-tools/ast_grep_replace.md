<!--
Назначение: описание и параметры инструмента ast_grep_replace, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/code/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ast_grep_replace

## описание

Предпросмотр или применение структурных замен ровно в одном файле. apply по умолчанию false. Движок разрешает метапеременные; применяемые байтовые диапазоны не должны пересекаться и должны совпадать с текущими байтами файла. Права сохраняются.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "pattern",
    "rewrite",
    "lang",
    "path"
  ],
  "properties": {
    "pattern": {
      "type": "string",
      "minLength": 1
    },
    "rewrite": {
      "type": "string"
    },
    "lang": {
      "type": "string",
      "minLength": 1
    },
    "path": {
      "type": "string",
      "minLength": 1
    },
    "apply": {
      "type": "boolean"
    }
  }
}
```
