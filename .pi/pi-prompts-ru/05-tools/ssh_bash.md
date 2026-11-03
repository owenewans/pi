<!--
Назначение: описание и параметры инструмента ssh_bash, предъявляемые модели.
Источник: /home/owenewans/Projects/lunera/pi/packages/coding-agent/src/extensions/ssh/index.ts
Статус: русская копия для правки, не используется Pi.
-->

# ssh_bash

## описание

Выполнить удалённую shell-команду через OpenSSH. host принимает user@host или псевдоним ~/.ssh/config; ключи, ProxyJump и ProxyCommand берутся из SSH-конфигурации пользователя. Без интерактивного ввода пароля.

## параметры

Имена, значения enum и ограничения ниже сохранены. Переведены только описания.

```json
{
  "type": "object",
  "required": [
    "host",
    "command"
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
    "command": {
      "type": "string",
      "minLength": 1
    },
    "cwd": {
      "type": "string"
    },
    "timeout": {
      "type": "integer",
      "minimum": 1,
      "maximum": 3600
    }
  }
}
```
