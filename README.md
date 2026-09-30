# pi-halogen-classify

Модель-классификатор для [Pi](https://pi.dev) поверх [halogen-flash-server](https://github.com/peonist-ai/halogen-flash-server).

Модель не генерирует текст. Каждый вопрос — один запрос к `/v1/chat/completions`,
обрёванный ровно там, где должна стоять метка. Сервер возвращает `logprobs`
следующего токена, ответ — softmax по токенам-меткам. Быстро, дёшево, локально и
приватно. Приём описан в `docs/CLASSIFY.md` у halogen и повторяет встроенный в
pi `llama-cpp-classify`, но поверх OpenAI-совместимого эндпоинта.

## Установка

Как и другие пакеты Pi — из git, npm или локального пути:

```bash
pi install git:github.com/<you>/pi-halogen-classify
# или для прогона без записи в settings:
pi -e git:github.com/<you>/pi-halogen-classify
# или локально:
pi install ~/work/extensions/pi-halogen-classify
```

После установки — `/reload` в сессии Pi, чтобы подхватить провайдер.

## Настройка

Узлы halogen задаются окружением, чтобы пакет переиспользовался на разных машинах:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HALOGEN_MS1_BASE_URL` | `http://192.168.1.7:8080/v1` | Узел `halogen/ms1` |
| `HALOGEN_MS2_BASE_URL` | `http://192.168.1.8:8080/v1` | Узел `halogen/ms2` |
| `HALOGEN_MODEL` | `halogen-qwen3.8-flash-next` | Имя модели, отправляемое серверу |
| `HALOGEN_API_KEY` | `dummy` | Ключ (halogen его не проверяет) |

Добавить узел — допишите элемент в `NODES` в `index.ts`.

Регистрируется отдельный провайдер `halogen`, чтобы не затирать чат-модели
существующих провайдеров (MS-1/MS-2). Список `models` в регистрации
перезаписывает все модели провайдера по всем операциям, поэтому классификатор
вынесен под собственным именем.

## Использование

Классификаторы не появляются в `/model`. Доступ к ним — из `codemode` или из
расширений.

### Из codemode

```js
const m = await models.getModelOfType("classifier", "halogen", "ms1");
const r = await models.classify(m, {
  state: { ticket: "The export button does nothing since the last update." },
  questions: {
    kind: {
      type: "choice",
      instructions: "Тип тикета?",
      criteria: { bug: "Дефект", feature: "Запрос функции", question: "Вопрос" },
    },
    urgent: {
      type: "bool",
      instructions: "Срочно?",
      criteria: { true: "Нужно сразу", false: "Можно подождать" },
    },
  },
});
return r.answers;
```

### Чек-лист по документу

Документ кладётся в `state` (в системное сообщение), вопросы — по одному bool. Все
вопросы делят системное сообщение, сервер прогоняет документ один раз и держит его
в prompt-кэше. Стоимость вопроса стремится к нулю с ростом их числа.

```js
const m = await models.getModelOfType("classifier", "halogen", "ms1");
const doc = `...текст контракта...`;
const CHECKLIST = {
  auto_renewal: "Does the contract auto-renew at term end?",
  eu_data: "Is customer data processed in the EU?",
  source_escrow: "Is source code escrow included?",
};
const questions = Object.fromEntries(Object.entries(CHECKLIST).map(([id, q]) => [id, {
  type: "bool", instructions: q,
  criteria: { true: "The document states this", false: "Stated otherwise or not provided" },
}]));
const r = await models.classify(m, { state: { contract: doc }, questions });
const T = 0.7;
return Object.fromEntries(Object.entries(r.answers).map(([id, a]) =>
  [id, a.probability >= T ? "да" : a.probability <= 1 - T ? "нет" : "проверить"]));
```

### Из своего расширения

```ts
const model = ctx.modelRegistry.findOfType("classifier", "halogen", "ms1");
const result = await ctx.modelRegistry.classify(model, { state, questions });
```

### Типы ответов

- `choice` → `{ choice, probabilities, confidence }`
- `bool` → `{ probability }`
- `score` → `{ score, confidence }` (математическое ожидание по уровням)

`result.usage` несёт токены и стоимость по тарифам каталога модели.

## Как это работает

1. `state` + инструкция → общее системное сообщение (кэшируется).
2. Вопрос с подписанными метками → user-сообщение.
3. Префикс ассистента `{"answer": "` → точка обрыва генерации.
4. Запрос: `continue_final_message`, `enable_thinking:false`, `max_tokens:1`,
   `temperature:0`, `logprobs:true`, `top_logprobs:20`.
5. `top_logprobs` → вероятности меток → ответ нужного типа.

Метки: `choice` — буквы A/B/C…, `score` — цифры 0–9, `bool` — `A`/`No`. Все
одно-токенные.

## Ограничения

- **Поверхностное чтение, не многошаговая логика.** Метка ставится до рассуждения.
  «Указано ли X в тексте» — да; «следует ли X косвенно» — нет. Для вывода —
  обычный запрос с thinking и `response_format`.
- **Вероятности не откалиброваны.** Порог подбирайте на своей размеченной выборке.
- **`top_logprobs` ≤ 20.** Метка вне топ-20 получает почти нулевую вероятность.
- **Метки — один токен.** `bug`/`bugfix` не годятся: считается только первый токен.

## Разработка

```bash
npm install      # dev-зависимости для typecheck/тестов
npm run typecheck
npm test         # офлайн-тесты чистой логики (без сети)
```

## Лицензия

MIT
