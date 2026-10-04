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
 * Чистые функции (buildGuardContext, decideGuard, buildBlockReason) тестируются офлайн.
 * Хенддер подключается в index.ts, когда `guard.enabled === true`.
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
