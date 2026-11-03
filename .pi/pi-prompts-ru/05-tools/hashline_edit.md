<!--
Назначение: описание и параметры инструмента hashline_edit, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/code/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# hashline_edit

## описание

Применить правки по якорям из последнего hashline_read. Каждая операция использует точный якорь LINE:HASH и массив строк замены. replace охватывает включительный диапазон; insert_before/after используют якорь; append добавляет в конец. Пересечения и устаревшие якоря приводят к отказу без записи.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "path",
    "edits"
  ],
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1
    },
    "edits": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "op",
              "start",
              "lines"
            ],
            "properties": {
              "op": {
                "type": "string",
                "const": "replace"
              },
              "start": {
                "type": "string"
              },
              "end": {
                "type": "string"
              },
              "lines": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          {
            "type": "object",
            "required": [
              "op",
              "anchor",
              "lines"
            ],
            "properties": {
              "op": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "insert_before"
                  },
                  {
                    "type": "string",
                    "const": "insert_after"
                  }
                ]
              },
              "anchor": {
                "type": "string"
              },
              "lines": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          {
            "type": "object",
            "required": [
              "op",
              "lines"
            ],
            "properties": {
              "op": {
                "type": "string",
                "const": "append"
              },
              "lines": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        ]
      },
      "minItems": 1
    }
  }
}
```
