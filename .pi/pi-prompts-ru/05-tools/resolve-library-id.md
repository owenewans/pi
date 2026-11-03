<!--
Назначение: описание и параметры инструмента resolve-library-id, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/context7/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# resolve-library-id

## описание

Найти ID библиотеки Context7 по имени пакета. Разреши ID перед query-docs, если пользователь не дал точный /org/project[/version]. Не больше трёх вызовов на вопрос. Запросы отправляются в Context7; исключай секреты и приватный код.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "libraryName",
    "query"
  ],
  "properties": {
    "libraryName": {
      "type": "string",
      "minLength": 1
    },
    "query": {
      "type": "string",
      "minLength": 1
    }
  }
}
```
