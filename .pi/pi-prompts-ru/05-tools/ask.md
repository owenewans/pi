<!--
Назначение: описание и параметры инструмента ask, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/workflow/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ask

## описание

Задавай уточняющие вопросы, в том числе короткие, через этот инструмент, а не в чате. Предлагай варианты ответа, когда это уместно. Спрашивай, только если без недостающего факта нельзя правильно выполнить работу.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "questions"
  ],
  "properties": {
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "question"
        ],
        "properties": {
          "question": {
            "type": "string",
            "minLength": 1
          },
          "choices": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "minItems": 1
    }
  }
}
```
