/**
 * guard.ts — предохранитель на классификаторе.
 *
 * Перед исполнением shell-команды она прогоняется через halogen-классификатор.
 * Команды вне категории `safe` с достаточной уверенностью блокируются через
 * `tool_call`-хенддер pi (`{ block: true, reason }`).
 *
 * К причине блока прикладывается подсказка: не повторять команду, а сузить её или
 * попросить пользователя исполнить команду самому (buildBlockReason, BLOCK_HINTS).
 *
 * Поведение fail-open: при недоступном классификаторе команда пропускается. Чтобы
 * пропуск не был невидим, `describeGuardFailure` + `buildGuardUnavailableMessage`
 * дают текст предупреждения в UI — на каждой пропущенной команде.
 *
 * Чистые функции (buildGuardContext, decideGuard, buildBlockReason,
 * describeGuardFailure, buildGuardUnavailableMessage, guardFailureOf)
 * тестируются офлайн. Хенддер подключается в index.ts, когда `guard.enabled === true`.
 */

import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";

/**
 * Режим реакции guard'а на опасную команду. Классификация выполняется в любом
 * режиме — режим меняет только реакцию на решение.
 *
 * - `strict` — автоотказ: опасная команда блокируется (историческое поведение, алиас 1);
 * - `ask` — диалог: пользователя спрашивают через `ctx.ui.confirm`, блок по отказу (алиас 2);
 * - `warn` — свободный доступ: команда проходит, в чат идёт предупреждение (алиас 3).
 */
export type GuardMode = "strict" | "ask" | "warn";

/** Человекочитаемое описание режима — для статуса и диалога выбора. */
export const GUARD_MODES: Record<GuardMode, string> = {
	strict: "автоотказ — опасные команды блокируются",
	ask: "диалог — опасную команду подтверждает пользователь",
	warn: "свободный доступ — опасные команды проходят с предупреждением",
};

/** Порядок режимов в диалоге выбора и в подсказках. */
export const GUARD_MODE_ORDER: readonly GuardMode[] = ["strict", "ask", "warn"];

export function isGuardMode(value: unknown): value is GuardMode {
	return value === "strict" || value === "ask" || value === "warn";
}

/** Числовые алиасы имён: 1=strict, 2=ask, 3=warn. */
const GUARD_MODE_ALIASES: Record<string, GuardMode> = {
	"1": "strict",
	"2": "ask",
	"3": "warn",
	strict: "strict",
	ask: "ask",
	warn: "warn",
};

/**
 * Разбор режима из конфига, env или аргумента команды: имя (регистр не важен)
 * или числовой алиас. `undefined` — значение не распознано.
 */
export function parseGuardMode(value: unknown): GuardMode | undefined {
	const key = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().toLowerCase() : undefined;
	return key === undefined ? undefined : GUARD_MODE_ALIASES[key];
}

export interface GuardConfig {
	/** Включён ли предохранитель. По умолчанию выключен — включается на машине. */
	enabled: boolean;
	/** Режим реакции на опасную команду. По умолчанию `strict` (автоотказ). */
	mode: GuardMode;
	/** id узла-классификатора (ms1/ms2), которым проверять. */
	node: string;
	/** Блокировать, если категория не `safe` и уверенность >= порога. */
	blockThreshold: number;
	/**
	 * Подсказка агенту в причине блока. `undefined` — встроенный текст по категории
	 * из `BLOCK_HINTS`. Пустая строка — подсказку не добавлять. `{category}` в тексте
	 * заменяется на категорию решения.
	 */
	blockHint?: string;
}

export const DEFAULT_GUARD: GuardConfig = {
	enabled: false,
	mode: "strict",
	node: "ms1",
	blockThreshold: 0.6,
};

/** Категории риска. `safe` — единственная пропускаемая. */
export const RISK_CRITERIA: Record<string, string> = {
	safe: "Ordinary developer work inside a project: read files, build, test, git, list or search a specific project directory",
	root_search:
		"Recursive search from the filesystem root or a broad system path, e.g. 'find /', 'grep -r /', 'ls /', scanning the whole system",
	destructive:
		"Mass or forced deletion or overwrite: 'rm -rf', 'dd', 'mkfs', wiping directories or disks",
	privileged:
		"Privilege escalation or system config change: 'sudo', writing to /etc, /usr, /bin, chmod -R on system dirs",
};

/**
 * Подсказка агенту под запретом. Блок сам по себе агенту не полезен: он повторяет
 * команду или ищет обход. Поэтому к причине прикладывается допустимый обход —
 * сузить команду либо попросить пользователя исполнить её самому.
 */
export const BLOCK_HINTS: Record<string, string> = {
	destructive:
		"Do not retry this command and do not look for a way around the guard. First check for a narrower, non-forced alternative. If the deletion or overwrite is genuinely required, ask the user to run it themselves: say why it is needed, give the exact command, then wait until they confirm it is done.",
	root_search:
		"Do not retry this command. Restrict the search to the project directory or another specific path. If a system-wide search is genuinely required, ask the user to run it themselves and give the exact command.",
	privileged:
		"Do not retry this command. If this change genuinely needs elevated rights, ask the user to run it themselves: say why it is needed, give the exact command, then wait until they confirm it is done.",
	unknown:
		"Do not retry this command. If it is genuinely required, ask the user to run it themselves and give the exact command.",
};

/** Подстановка `{category}` в тексте подсказки. */
export function fillHint(hint: string, category: string): string {
	return hint.replace(/\{category\}/g, category);
}

/**
 * Причина блока, которую видит модель: заголовок с категорией и уверенностью плюс
 * подсказка. Команду не повторяем — она видна модели в её же вызове инструмента.
 * `hint === undefined` — текст по категории, пустой `hint` — без подсказки.
 */
export function buildBlockReason(decision: GuardDecision, hint?: string): string {
	const head =
		`halogen guard: blocked (category: ${decision.category}, ` +
		`confidence: ${decision.confidence.toFixed(2)})`;
	const text = hint === undefined ? BLOCK_HINTS[decision.category] ?? BLOCK_HINTS.unknown : hint;
	if (!text.trim()) return head;
	return `${head}\n${fillHint(text, decision.category)}`;
}

/** ClassifierContext для проверки одной команды. */
export function buildGuardContext(command: string): ClassifierContext {
	return {
		state: { command },
		questions: {
			risk: {
				type: "choice",
				instructions:
					"Classify the risk of this shell command being run by an AI coding agent on a developer machine.",
				criteria: RISK_CRITERIA,
			},
		},
	};
}

export interface GuardDecision {
	block: boolean;
	category: string;
	confidence: number;
}

/**
 * Категория отказа предохранителя — в любой из них команду пропускают без проверки:
 * - `no_model` — классификатор `guard.node` не зарегистрирован (id вне `nodes`);
 * - `classify_error` — запрос к узлу не прошёл (сервер упал, таймаут, ошибка ответа);
 * - `bad_answer` — узел ответил, но категории риска в ответе нет.
 */
export type GuardFailure = "no_model" | "classify_error" | "bad_answer";

/** Максимальная длина текста причины отказа в сообщении. */
const FAILURE_DETAIL_MAX_CHARS = 160;

/** Текст ошибки в одну строку произвольной длины. */
function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return error === undefined || error === null ? "" : String(error);
}

/** Свёртка текста в одну строку длиной не больше `max`. */
function collapse(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Причина отказа: почему команду не проверили. */
export function describeGuardFailure(failure: GuardFailure, node: string, error?: unknown): string {
	if (failure === "no_model") {
		return `классификатор ${node} не зарегистрирован`;
	}
	if (failure === "bad_answer") {
		return `узел ${node} не вернул категорию риска`;
	}
	const detail = collapse(errorText(error) || "ошибка классификатора", FAILURE_DETAIL_MAX_CHARS);
	return `узел ${node} недоступен: ${detail}`;
}

/**
 * Отказ по результату классификации; `undefined` — ответ пригоден, проверять дальше.
 *
 * Классификаторы pi не бросают на ошибке провайдера, а возвращают `stopReason:
 * "error"` с `errorMessage`, поэтому ловить отказ нужно здесь, а не в `catch`.
 * Прерванный агентом запрос (`aborted`) отказом узла не считается.
 */
export function guardFailureOf(result: ClassifierResult): GuardFailure | undefined {
	if (result.stopReason === "error") return "classify_error";
	if (result.stopReason === "aborted") return undefined;
	const answer = result.answers?.risk;
	return answer && answer.type === "choice" ? undefined : "bad_answer";
}

/**
 * Предупреждение пользователю о пропуске команды без проверки: что случилось и что
 * делать. Текст человеческий, не для модели, поэтому на русском, как и README.
 */
export function buildGuardUnavailableMessage(
	failure: GuardFailure,
	node: string,
	error?: unknown,
): string {
	return (
		`halogen guard: проверка не выполнена (${describeGuardFailure(failure, node, error)}), ` +
		`команда пропущена без проверки. ` +
		`Проверьте guard.node и доступность сервера в halogen-classify.json, ` +
		`либо отключите guard: HALOGEN_GUARD=0`
	);
}

/**
 * Реакция guard'а на решение классификатора в заданном режиме.
 * `pass` — пропустить молча; `block` — отказать модели; `ask` — спросить
 * пользователя; `warn` — пропустить с предупреждением в чат.
 */
export type GuardAction = "pass" | "block" | "ask" | "warn";

export function guardActionOf(decision: GuardDecision, mode: GuardMode): GuardAction {
	if (!decision.block) return "pass";
	if (mode === "ask") return "ask";
	if (mode === "warn") return "warn";
	return "block";
}

/** Категория и уверенность одной строкой — общая для текстов режимов 2 и 3. */
export function formatDecision(decision: GuardDecision): string {
	return `category: ${decision.category}, confidence: ${decision.confidence.toFixed(2)}`;
}

/** Текст диалога подтверждения (режим `ask`). */
export function buildAskMessage(decision: GuardDecision): string {
	return (
		`halogen guard: команда классифицирована как опасная (${formatDecision(decision)}). ` +
		`Разрешить исполнение?`
	);
}

/** Причина для модели, когда пользователь отказал в диалоге (режим `ask`). */
export function buildUserDeniedReason(decision: GuardDecision): string {
	return (
		`halogen guard: the user denied this command in the confirmation dialog (${formatDecision(decision)}). ` +
		`Do not retry it. Ask the user what to do instead.`
	);
}

/** Предупреждение в чат при пропуске опасной команды (режим `warn`). */
export function buildWarnMessage(decision: GuardDecision): string {
	return `halogen guard: опасная команда пропущена без блокировки (${formatDecision(decision)})`;
}

/** Решение по результату классификации: блокировать или пропустить. */
export function decideGuard(result: ClassifierResult, blockThreshold: number): GuardDecision {
	const answer = result.answers?.risk;
	if (!answer || answer.type !== "choice") {
		return { block: false, category: "unknown", confidence: 0 };
	}
	const category = answer.choice;
	const confidence = answer.confidence;
	const block = category !== "safe" && confidence >= blockThreshold;
	return { block, category, confidence };
}
