<!--
Назначение: навык добавления нового поставщика LLM в packages/ai.
Источник: /home/owenewans/Projects/lunera/pi/.pi/skills/add-llm-provider.md
Статус: русская копия для правки, не используется Pi.
-->
---
name: add-llm-provider
description: Порядок добавления нового поставщика LLM в packages/ai. Охватывает основные типы, реализацию поставщика, ленивую регистрацию, генерацию моделей, полную матрицу тестов, подключение coding-agent и документацию.
---

# Добавление нового поставщика LLM (packages/ai)

Добавление нового поставщика затрагивает несколько файлов. Выполните следующие шаги по порядку.

## 1. Основные типы (`packages/ai/src/types.ts`)

- Добавьте имя поставщика в объединение `KnownProvider`.
- Только для нового API: добавьте идентификатор API в `KnownApi` (например, `"bedrock-converse-stream"`) и тип его параметров в `ApiOptionsMap`.

## 2. Реализация API (`packages/ai/src/api/`, только для нового API)

Большинство поставщиков используют существующий API, например `openai-completions`; в таком случае пропустите этот шаг.

- `src/api/<api-id>.ts` экспортирует ровно `stream` и `streamSimple`, а также интерфейс параметров, расширяющий `StreamOptions`.
- Преобразуйте сообщения и инструменты в формат поставщика. Считывайте промпт и инструменты из записи разговора с помощью `getInitialSystemMessage()`, `getCurrentTools()` и `resolveTranscript()`.
- Разбирайте ответы в стандартизированные события (`text`, `tool_call`, `thinking`, `usage`, `stop`).
- Добавьте ленивую обёртку `src/api/<api-id>.lazy.ts` (`<name>Api()` через `lazyApi()`), чтобы поставщики могли ссылаться на реализацию без импорта её SDK.
- Зарегистрируйте ленивую обёртку в списке встроенных API в `src/compat.ts`.
- Добавьте реэкспорты `export type` в `src/index.ts` для типов параметров, которые должны быть доступны из корневой точки входа. Экспорт подпути `./api/*` в `package.json` уже охватывает новый модуль.

## 3. Каталог моделей (`packages/ai/catalog/providers/<id>.ts`)

- Добавьте определение поставщика с помощью `defineProvider()` и зарегистрируйте его в `catalog/providers/index.ts`. Сначала прочитайте `packages/ai/catalog/README.md`.
- Для поставщика из models.dev используйте `modelsDevModels()`; задавайте значения совместимости по умолчанию для каждого API в `compat`, а специфичное для поставщика поведение в `finalize`.
- Повторно сгенерируйте файлы командой `npm run generate-models` в `packages/ai`. Она записывает стабильную обёртку каталога `src/providers/<id>.models.ts` (экспортирующую `<ID>_MODELS`), которую импортирует фабрика поставщика, и обновляет `src/models.generated.ts`.

## 4. Фабрика поставщика и аутентификация (`packages/ai/src/providers/`)

- Создайте `src/providers/<id>.ts`, экспортирующий `<id>Provider()`, который вызывает `createProvider({ id, name, baseUrl, auth, models, api })`. `name` задаёт отображаемое имя в `/login` и связанном интерфейсе. Минимальный пример приведён в `deepseek.ts`.
- Аутентификация: `envApiKeyAuth()` для стандартных ключей API, собственный `ApiKeyAuth` для учётных данных из окружения (профили AWS, ADC), `lazyOAuth()` при наличии процесса OAuth.
- Передайте ленивую обёртку API (например, `openAICompletionsApi()`) как `api`; не импортируйте модули реализации API статически.
- Зарегистрируйте фабрику в `src/providers/all.ts`.
- Добавьте переменную окружения в `src/env-api-keys.ts`, чтобы функция совместимости `getEnvApiKey()` находила её.

## 5. Тесты (`packages/ai/test/`)

- Всегда добавляйте поставщика в `stream.test.ts` хотя бы с одной показательной моделью, даже если он использует существующую реализацию API, например `openai-completions`.
- При необходимости добавьте поставщика в более широкую матрицу: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- В `cross-provider-handoff.test.ts` добавьте хотя бы одну пару поставщик/модель. Если поставщик предоставляет несколько семейств моделей (например, GPT и Claude), добавьте хотя бы одну пару для каждого семейства.
- Для нестандартной аутентификации создайте вспомогательный модуль (например, `bedrock-utils.ts`) с обнаружением учётных данных.

## 6. Агент программирования (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: добавьте идентификатор модели по умолчанию в `defaultModelPerProvider`.
- `src/cli/args.ts`: добавьте документацию переменной окружения.
- `docs/providers.md`: добавьте инструкции по настройке, переменную окружения и ключ `auth.json`.

## 7. Документация

- `packages/ai/README.md`: добавьте запись в таблицу поставщиков, опишите параметры и аутентификацию, добавьте переменные окружения.
- `packages/ai/CHANGELOG.md`: добавьте запись в раздел `## [Unreleased]`.
