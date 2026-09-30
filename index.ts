/**
 * pi-halogen-classify — точка входа.
 *
 * Регистрирует отдельный провайдер `halogen` с моделями-классификаторами по числу
 * узлов halogen-flash-server и подключает реализацию `classify` под api
 * `halogen-classify`.
 *
 * Почему отдельный провайдер: список `models` в регистрации перезаписывает все
 * модели провайдера по всем операциям. Если бы классификатор объявлялся под
 * именем чат-провайдера (MS-1/MS-2), он затёр бы чат-модель. Отдельное имя
 * `halogen` держит чат (models.json) и классификатор (код) на разных слоях.
 *
 * Узлы настраиваются окружением, чтобы пакет переиспользовался на других машинах:
 *   HALOGEN_MS1_BASE_URL  (default http://192.168.1.7:8080/v1)
 *   HALOGEN_MS2_BASE_URL  (default http://192.168.1.8:8080/v1)
 *   HALOGEN_MODEL         (default halogen-qwen3.8-flash-next)
 *   HALOGEN_API_KEY       (default dummy — halogen ключ не проверяет)
 *
 * Как добавить узел: допишите элемент в NODES ниже.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_API, classify, setServerModel } from "./classify.ts";

const DEFAULT_MODEL = process.env.HALOGEN_MODEL || "halogen-qwen3.8-flash-next";

/** Тарифы по умолчанию (за миллион токенов). Правьте под свой стенд. */
const COST = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };

interface NodeConfig {
	id: string;
	baseUrl: string;
	contextWindow: number;
}

const NODES: NodeConfig[] = [
	{
		id: "ms1",
		baseUrl: process.env.HALOGEN_MS1_BASE_URL || "http://192.168.1.7:8080/v1",
		contextWindow: 524288,
	},
	{
		id: "ms2",
		baseUrl: process.env.HALOGEN_MS2_BASE_URL || "http://192.168.1.8:8080/v1",
		contextWindow: 262144,
	},
];

export default function (pi: ExtensionAPI): void {
	for (const node of NODES) {
		setServerModel(node.id, DEFAULT_MODEL);
	}

	pi.registerProvider("halogen", {
		apiKey: process.env.HALOGEN_API_KEY || "dummy",
		models: NODES.map((node) => ({
			type: "classifier" as const,
			id: node.id,
			name: `Halogen ${node.id} (classify)`,
			api: CLASSIFIER_API,
			baseUrl: node.baseUrl,
			input: ["text"] as const,
			cost: COST,
			contextWindow: node.contextWindow,
		})),
		classifiers: {
			[CLASSIFIER_API]: { classify },
		},
	});
}
