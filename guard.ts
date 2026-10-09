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

export interface GuardConfig {
	/** Включён ли предохранитель. По умолчанию выключен — включается на машине. */
	enabled: boolean;
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
