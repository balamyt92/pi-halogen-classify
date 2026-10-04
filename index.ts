/**
 * pi-halogen-classify — точка входа.
 *
 * 1. Регистрирует провайдер `halogen` с классификатор-моделями узлов (из конфига).
 * 2. Если `guard.enabled` — вешает `tool_call`-хенддер: каждая bash/powershell
 *    команда прогоняется через классификатор, опасные блокируются.
 *
 * Конфиг: `~/.pi/agent/halogen-classify.json` (пер-машинный, не затирается при
 * `pi update`), поверх — env, поверх — дефолты. См. config.ts и README.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { CLASSIFIER_API, classify, setServerModel } from "./classify.ts";
import { buildBlockReason, buildGuardContext, decideGuard } from "./guard.ts";

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
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash" && event.toolName !== "powershell") {
				return undefined;
			}
			const command = String((event.input as Record<string, unknown>)?.command ?? "");
			if (!command.trim()) return undefined;

			const model = ctx.modelRegistry.findOfType("classifier", "halogen", cfg.guard.node);
			if (!model) return undefined; // классификатор недоступен — не блокируем

			let result;
			try {
				result = await ctx.modelRegistry.classify(model, buildGuardContext(command));
			} catch {
				return undefined; // ошибка классификатора — не блокируем (best-effort)
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
