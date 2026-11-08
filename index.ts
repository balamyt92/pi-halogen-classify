/**
 * pi-halogen-classify — точка входа.
 *
 * 1. Регистрирует провайдер `halogen` с классификатор-моделями узлов (из конфига).
 * 2. Если `guard.enabled` — вешает `tool_call`-хенддер: каждая bash/powershell
 *    команда прогоняется через классификатор; классификация выполняется всегда,
 *    а реакция зависит от режима (`guard.mode`, переключается `/halogen-guard`):
 *    `strict` — автоотказ, `ask` — диалог подтверждения, `warn` — пропуск с
 *    предупреждением; числовые алиасы 1/2/3 тоже принимаются.
 *
 * Fail-open: при недоступном классификаторе команда проходит, но пользователь
 * получает предупреждение в UI (см. guard.ts, `buildGuardUnavailableMessage`).
 *
 * Конфиг: `~/.pi/agent/halogen-classify.json` (пер-машинный, не затирается при
 * `pi update`), поверх — env, поверх — дефолты. См. config.ts и README.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { CLASSIFIER_API, classify, setServerModel } from "./classify.ts";
import {
	buildAskMessage,
	buildBlockReason,
	buildGuardContext,
	buildGuardUnavailableMessage,
	buildUserDeniedReason,
	buildWarnMessage,
	decideGuard,
	guardActionOf,
	guardFailureOf,
	GUARD_MODE_ORDER,
	GUARD_MODES,
	parseGuardMode,
	type GuardFailure,
	type GuardMode,
} from "./guard.ts";

export default function (pi: ExtensionAPI): void {
	const cfg = loadConfig();

	for (const node of cfg.nodes) {
		setServerModel(node.id, cfg.model);
	}

	pi.registerProvider("halogen", {
		apiKey: cfg.apiKey,
		models: cfg.nodes.map((node) => ({
			type: "classifier" as const,
			id: node.id,
			name: `Halogen ${node.id} (classify)`,
			api: CLASSIFIER_API,
			baseUrl: node.baseUrl,
			input: ["text"] as const,
			cost: cfg.cost,
			contextWindow: node.contextWindow,
		})),
		classifiers: {
			[CLASSIFIER_API]: { classify },
		},
	});

	if (cfg.guard.enabled) {
		/**
		 * Текущий режим — состояние сессии: `/halogen-guard` меняет его на ходу,
		 * конфиг остаётся стартовым значением. Классификация выполняется в любом
		 * режиме, режим меняет только реакцию на опасное решение.
		 */
		let mode: GuardMode = cfg.guard.mode;

		const announce = (ctx: ExtensionContext): void => {
			ctx.ui.notify(`halogen guard: режим «${mode}» — ${GUARD_MODES[mode]}`, "info");
		};

		pi.registerCommand("halogen-guard", {
			description: "Режим guard: strict автоотказ, ask диалог, warn предупреждения (без аргумента — выбор)",
			getArgumentCompletions: (prefix: string) => {
				const items = [
					...GUARD_MODE_ORDER.map((m) => ({ value: m, label: `${m} — ${GUARD_MODES[m]}` })),
					{ value: "status", label: "status — текущий режим" },
				];
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			},
			handler: async (args: string, ctx: ExtensionContext) => {
				const arg = args.trim().toLowerCase();
				if (arg === "status") {
					announce(ctx);
					return;
				}
				if (arg === "") {
					const labels = GUARD_MODE_ORDER.map((m) => `${m} — ${GUARD_MODES[m]}`);
					const choice = await ctx.ui.select(`halogen guard (сейчас «${mode}»): выбрать режим`, labels);
					if (choice === undefined) return;
					mode = GUARD_MODE_ORDER[labels.indexOf(choice)];
					announce(ctx);
					return;
				}
				const next = parseGuardMode(arg);
				if (next === undefined) {
					ctx.ui.notify("halogen guard: аргумент — strict, ask, warn (или 1, 2, 3) либо status", "error");
					return;
				}
				mode = next;
				announce(ctx);
			},
		});

		/**
		 * Предупредить пользователя, что команда прошла без проверки. Повторы не
		 * подавляются: каждое срабатывание guard видно в транскрипте.
		 */
		const warnUnavailable = (ctx: ExtensionContext, failure: GuardFailure, error?: unknown): void => {
			ctx.ui.notify(buildGuardUnavailableMessage(failure, cfg.guard.node, error), "warning");
		};

		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash" && event.toolName !== "powershell") {
				return undefined;
			}
			const command = String((event.input as Record<string, unknown>)?.command ?? "");
			if (!command.trim()) return undefined;

			const model = ctx.modelRegistry.findOfType("classifier", "halogen", cfg.guard.node);
			if (!model) {
				// классификатор недоступен — не блокируем, но и не молчим
				warnUnavailable(ctx, "no_model");
				return undefined;
			}

			let result;
			try {
				result = await ctx.modelRegistry.classify(model, buildGuardContext(command));
			} catch (error) {
				// реестр бросает только на своей ошибке (нет реализации API)
				warnUnavailable(ctx, "classify_error", error);
				return undefined;
			}

			// ошибочный ответ узла classify возвращает, а не бросает
			const failure = guardFailureOf(result);
			if (failure) {
				warnUnavailable(ctx, failure, result.errorMessage);
				return undefined;
			}

			const decision = decideGuard(result, cfg.guard.blockThreshold);
			switch (guardActionOf(decision, mode)) {
				case "block":
					return {
						block: true,
						reason: buildBlockReason(decision, cfg.guard.blockHint),
					};
				case "ask": {
					// Без UI или при ошибке диалога — отказ: в режиме 2 молча не пропускаем.
					let allowed = false;
					try {
						allowed = await ctx.ui.confirm("Halogen guard", buildAskMessage(decision));
					} catch {
						allowed = false;
					}
					if (!allowed) {
						return { block: true, reason: buildUserDeniedReason(decision) };
					}
					return undefined;
				}
				case "warn":
					ctx.ui.notify(buildWarnMessage(decision), "warning");
					return undefined;
				default:
					return undefined;
			}
		});
	}
}
