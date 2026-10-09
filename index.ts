/**
 * pi-halogen-classify — точка входа.
 *
 * 1. Регистрирует провайдер `halogen` с классификатор-моделями узлов (из конфига).
 * 2. Если `guard.enabled` — вешает `tool_call`-хенддер: каждая bash/powershell
 *    команда прогоняется через классификатор, опасные блокируются.
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
	buildBlockReason,
	buildGuardContext,
	buildGuardUnavailableMessage,
	decideGuard,
	guardFailureOf,
	type GuardFailure,
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
			if (decision.block) {
				return {
					block: true,
					reason: buildBlockReason(decision, cfg.guard.blockHint),
				};
			}
			return undefined;
		});
	}
}
