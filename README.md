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
pi install git:github.com/balamyt92/pi-halogen-classify
# или для прогона без записи в settings:
pi -e git:github.com/balamyt92/pi-halogen-classify
# или локально:
pi install ~/work/extensions/pi-halogen-classify
```

После установки — `/reload` в сессии Pi, чтобы подхватить провайдер.

## Настройка

Основной способ — файл `~/.pi/agent/halogen-classify.json`. Он пер-машинный и не
затирается при `pi update`. Шаблон — `config.example.json` в пакете:

```json
{
  "apiKey": "dummy",
  "model": "halogen-qwen3.8-flash-next",
  "cost": { "input": 0.2, "output": 1.2, "cacheRead": 0.02, "cacheWrite": 0.25 },
  "nodes": [
    { "id": "ms1", "baseUrl": "http://192.168.1.7:8080/v1", "contextWindow": 524288 },
    { "id": "ms2", "baseUrl": "http://192.168.1.8:8080/v1", "contextWindow": 262144 }
  ],
  "guard": { "enabled": false, "node": "ms1", "blockThreshold": 0.6 }
}
```

Приоритет: **файл → env → дефолты**. Env удобен для CI и разовых переопределений:

| Переменная | Переопределяет |
|---|---|
| `HALOGEN_API_KEY` | `apiKey` |
| `HALOGEN_MODEL` | `model` |
| `HALOGEN_NODE_<ID>_BASE_URL` | `baseUrl` узла с этим id (напр. `HALOGEN_NODE_MS1_BASE_URL`) |
| `HALOGEN_GUARD` | `guard.enabled` (`1`/`true` вкл, `0`/`false` выкл) |
| `HALOGEN_GUARD_HINT` | `guard.blockHint` (пустая строка — отключить подсказку) |

Регистрируется отдельный провайдер `halogen`, чтобы не затирать чат-модели
существующих провайдеров (MS-1/MS-2). Список `models` в регистрации
перезаписывает все модели провайдера по всем операциям, поэтому классификатор
вынесен под собственным именем.

## Предохранитель (guard)

Когда `guard.enabled: true`, расширение вешает `tool_call`-хенддер: каждая
`bash`/`powershell` команда перед исполнением прогоняется через классификатор и
блокируется, если попадает в опасную категорию с уверенностью выше порога.

Категории риска:

| Категория | Что ловит |
|---|---|
| `safe` | Обычная работа в проекте: чтение, сборка, тесты, git, поиск по конкретной директории |
| `root_search` | Рекурсивный поиск от корня ФС или по широкому системному пути (`find /`, `grep -r /`, `ls /`) |
| `destructive` | Массовое/принудительное удаление или перезапись (`rm -rf`, `dd`, `mkfs`) |
| `privileged` | Эскалация прав или правка системы (`sudo`, запись в `/etc`, `chmod -R` на системных путях) |

Блокируется всё, что не `safe` и имеет уверенность `>= blockThreshold` (по
умолчанию 0.6).

### Подсказка под запретом

Голый запрет агенту не полезен: модель повторяет запрещённую команду или ищет
обход. Поэтому в причину блока, которую видит модель, кладётся допустимый обход —
сузить команду либо попросить пользователя исполнить её самому. Саму команду в
причине не повторяем — она уже видна модели в её же вызове инструмента. Причина
выглядит так:

```
halogen guard: blocked (category: destructive, confidence: 0.92)
Do not retry this command and do not look for a way around the guard. First check for a
narrower, non-forced alternative. If the deletion or overwrite is genuinely required, ask
the user to run it themselves: say why it is needed, give the exact command, then wait
until they confirm it is done.
```

Текст подсказки свой для каждой категории (`BLOCK_HINTS` в `guard.ts`):

| Категория | Что подсказывает |
|---|---|
| `destructive` | Не повторять и не искать обход; сначала найти более узкую команду без `-f`; если удаление правда нужно — попросить пользователя исполнить команду самому |
| `root_search` | Сузить путь до директории проекта; системный поиск по всему ФС — через пользователя |
| `privileged` | Права не повышать; нужную команду с `sudo` — пользователю |
| иная | Обобщённая: не повторять, при реальной необходимости — пользователю |

Настроить текст — `guard.blockHint` в конфиге или `HALOGEN_GUARD_HINT` в env. В
шаблоне доступен `{category}`. Пустая строка отключает подсказку, остаётся только
заголовок с категорией и уверенностью. Порождаемые по умолчанию тексты на
английском — язык текста к модели отношения не имеет, локализовать можно через
тот же `blockHint`.

Поведение при отказе — **fail-open**: если классификатор недоступен или вернул
ошибку, команда пропускается (предохранитель best-effort, не ломает работу при
упавшем halogen). Не-bash инструменты (`read`/`edit`/`write`) хенддер не
проверяет.

Выключить: `guard.enabled: false` в конфиге или `HALOGEN_GUARD=0`.

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

Метки: `choice` — латиница A–Z, a–z, затем цифры 0–9 (до 62 опций), `score` —
цифры 0–9, `bool` — `A`/`B` (`A` = да/true, `B` = нет/false). Все одно-токенные.

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
