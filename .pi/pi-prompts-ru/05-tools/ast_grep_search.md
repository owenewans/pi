<!--
Назначение: описание и параметры инструмента ast_grep_search, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/code/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ast_grep_search

## описание

Структурный поиск закреплённой версией ast-grep. Укажи lang и допустимый одноузловой AST-шаблон; $NAME захватывает один узел, $$$NAME несколько. Пути по умолчанию от cwd, / запрещён. Результаты включают точный текст, байтовые диапазоны и позиции. limit ограничивает возвращаемый вывод; сужай paths или pattern, если движок превышает бюджет вывода.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "pattern",
    "lang"
  ],
  "properties": {
    "pattern": {
      "type": "string",
      "minLength": 1
    },
    "lang": {
      "type": "string",
      "minLength": 1
    },
    "paths": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  }
}
```
