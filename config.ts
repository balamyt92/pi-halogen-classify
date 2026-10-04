/**
 * config.ts — загрузка конфигурации пакета.
 *
 * Приоритет (сверху вниз, более высокое перебивает):
 *   1. Файл `~/.pi/agent/halogen-classify.json`
 *   2. Переменные окружения (HALOGEN_*)
 *   3. Встроенные значения по умолчанию
 *
 * Файл живёт в agent-директории, а не внутри пакета: он пер-машинный и не
 * затирается при `pi update`. Чистые функции слияния (mergeConfig,
 * applyEnvOverrides, normalizeNodes) не трогают ФС — тестируются офлайн.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARD, type GuardConfig } from "./guard.ts";
export { DEFAULT_GUARD, type GuardConfig };

export interface NodeConfig {
	id: string;
	baseUrl: string;
	contextWindow: number;
}

export interface CostConfig {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface HalogenConfig {
	apiKey: string;
	model: string;
	cost: CostConfig;
	nodes: NodeConfig[];
	guard: GuardConfig;
}

export const CONFIG_FILENAME = "halogen-classify.json";

export const DEFAULT_CONFIG: HalogenConfig = {
	apiKey: "dummy",
	model: "halogen-qwen3.8-flash-next",
	cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	nodes: [
		{ id: "ms1", baseUrl: "http://192.168.1.7:8080/v1", contextWindow: 524288 },
		{ id: "ms2", baseUrl: "http://192.168.1.8:8080/v1", contextWindow: 262144 },
	],
	guard: { ...DEFAULT_GUARD },
};

const DEFAULT_CONTEXT_WINDOW = 262144;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Валидация и нормализация списка узлов из конфига. */
export function normalizeNodes(value: unknown): NodeConfig[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("`nodes` must be a non-empty array");
	}
	return value.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`nodes[${index}] must be an object`);
		}
		const id = entry.id;
		const baseUrl = entry.baseUrl;
		if (typeof id !== "string" || id.length === 0) {
			throw new Error(`nodes[${index}].id must be a non-empty string`);
		}
		if (typeof baseUrl !== "string" || baseUrl.length === 0) {
			throw new Error(`nodes[${index}].baseUrl must be a non-empty string`);
		}
		const cw = entry.contextWindow;
		const contextWindow = typeof cw === "number" && cw > 0 ? cw : DEFAULT_CONTEXT_WINDOW;
		return { id, baseUrl, contextWindow };
	});
}

/** Слияние объекта из файла с дефолтами. Поля файла имеют приоритет. */
export function mergeConfig(fileObj: unknown, defaults: HalogenConfig): HalogenConfig {
	if (!isRecord(fileObj)) {
		throw new Error("config file must contain a JSON object");
	}
	const cost: CostConfig = { ...defaults.cost };
	if (isRecord(fileObj.cost)) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const v = fileObj.cost[key];
			if (typeof v === "number") cost[key] = v;
		}
	}
	return {
		apiKey: typeof fileObj.apiKey === "string" ? fileObj.apiKey : defaults.apiKey,
		model: typeof fileObj.model === "string" ? fileObj.model : defaults.model,
		cost,
		nodes:
			fileObj.nodes !== undefined
				? normalizeNodes(fileObj.nodes)
				: defaults.nodes.map((n) => ({ ...n })),
		guard: mergeGuard(fileObj.guard, defaults.guard),
	};
}

/** Слияние секции guard: поля файла поверх дефолтов. */
export function mergeGuard(value: unknown, defaults: GuardConfig): GuardConfig {
	const out: GuardConfig = { ...defaults };
	if (!isRecord(value)) return out;
	if (typeof value.enabled === "boolean") out.enabled = value.enabled;
	if (typeof value.node === "string" && value.node.length > 0) out.node = value.node;
	if (typeof value.blockThreshold === "number" && value.blockThreshold >= 0 && value.blockThreshold <= 1) {
		out.blockThreshold = value.blockThreshold;
	}
	// Пустая строка — осознанный отказ от подсказки, поэтому проверяется тип, а не непустота.
	if (typeof value.blockHint === "string") out.blockHint = value.blockHint;
	return out;
}

/** Переопределение отдельных полей окружением (поверх файла). */
export function applyEnvOverrides(
	cfg: HalogenConfig,
	env: Record<string, string | undefined>,
): HalogenConfig {
	const out: HalogenConfig = {
		...cfg,
		cost: { ...cfg.cost },
		nodes: cfg.nodes.map((n) => ({ ...n })),
		guard: { ...cfg.guard },
	};
	if (env.HALOGEN_API_KEY) out.apiKey = env.HALOGEN_API_KEY;
	if (env.HALOGEN_MODEL) out.model = env.HALOGEN_MODEL;
	if (env.HALOGEN_GUARD === "1" || env.HALOGEN_GUARD === "true") out.guard.enabled = true;
	if (env.HALOGEN_GUARD === "0" || env.HALOGEN_GUARD === "false") out.guard.enabled = false;
	// Пустая строка в env отключает подсказку, поэтому сравнение с undefined.
	if (env.HALOGEN_GUARD_HINT !== undefined) out.guard.blockHint = env.HALOGEN_GUARD_HINT;
	// Переопределение базового URL узла по его id: HALOGEN_NODE_<ID>_BASE_URL.
	for (const node of out.nodes) {
		const key = `HALOGEN_NODE_${node.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
		const v = env[key];
		if (v) node.baseUrl = v;
	}
	return out;
}

/** Путь к пользовательскому конфигу. */
export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILENAME);
}

/**
 * Итоговая загрузка: файл (если есть) → env → дефолты.
 * Отсутствующий файл — не ошибка, работают дефолты. Невалидный JSON — явная ошибка.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): HalogenConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return applyEnvOverrides(DEFAULT_CONFIG, env);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`pi-halogen-classify: invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return applyEnvOverrides(mergeConfig(parsed, DEFAULT_CONFIG), env);
}
