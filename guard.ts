/**
 * guard.ts — предохранитель на классификаторе.
 *
 * Перед исполнением shell-команды она прогоняется через halogen-классификатор.
 * Команды вне категории `safe` с достаточной уверенностью блокируются через
 * `tool_call`-хенддер pi (`{ block: true, reason }`).
 *
 * Чистые функции (buildGuardContext, decideGuard) тестируются офлайн.
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
