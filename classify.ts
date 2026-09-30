/**
 * classify.ts — сеть и оркестрация: перевод ClassifierContext в запрос
 * halogen `/v1/chat/completions` с logprobs и обратно в ClassifierResult.
 *
 * Чистая логика (метки, рендеринг, математика) — в labels.ts.
 */

import type {
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ClassifierQuestion,
	ModelCost,
	Usage,
} from "@earendil-works/pi-ai";
import {
	ANSWER_PREFIX,
	answerFromProbabilities,
	answerInstruction,
	questionLabels,
	renderSystem,
	renderTask,
	labelProbabilities,
} from "./labels.ts";

/** Имя API, под которым регистрируется эта реализация. */
export const CLASSIFIER_API = "halogen-classify";

/** halogen ограничивает top_logprobs сверху числом 20. */
const TOP_LOGPROBS = 20;
/** Метка вне топ-K получает пол на эту величину ниже самой славой присутствующей. */
const MISSING_LABEL_DELTA = 10;
/** Имя модели на сервере по умолчанию (одно-модельный halogen его всё равно игнорирует). */
const DEFAULT_SERVER_MODEL = "halogen-qwen3.8-flash-next";

/**
 * pi id модели → настоящее имя модели на сервере.
 * Заполняется при регистрации (см. index.ts). Нужен, чтобы слать корректное поле
 * `model`, если сервер когда-нибудь начнёт его проверять.
 */
const serverModels = new Map<string, string>();

export function setServerModel(piModelId: string, serverModelName: string): void {
	serverModels.set(piModelId, serverModelName);
}

function serverModelFor(model: ClassifierModel<string>): string {
	return serverModels.get(model.id) ?? DEFAULT_SERVER_MODEL;
}

function normalizeBaseUrl(baseUrl: string): string {
	return String(baseUrl || "").replace(/\/+$/u, "");
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Стоимость по тарифам каталога модели (цена за миллион токенов). */
function computeCost(cost: ModelCost | undefined, u: Usage): Usage["cost"] {
	const rates = (cost ?? {}) as Record<string, number>;
	const per = (rate: number, tokens: number) => (Number(rate) || 0) * tokens * 1e-6;
	const input = per(rates.input, u.input);
	const output = per(rates.output, u.output);
	const cacheRead = per(rates.cacheRead, u.cacheRead);
	const cacheWrite = per(rates.cacheWrite, u.cacheWrite);
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postChat(
	baseUrl: string,
	apiKey: string | undefined,
	body: Record<string, unknown>,
	options: ClassifierOptions | undefined,
): Promise<Record<string, unknown>> {
	const requestFetch = options?.fetch ?? globalThis.fetch;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	const signal = options?.signal;
	const timeoutMs = options?.timeoutMs;
	const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
	const finalSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);

	let response: Response;
	try {
		response = await requestFetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: finalSignal,
		});
	} catch (err) {
		if (timeoutSignal?.aborted && !signal?.aborted) {
			throw new Error(`Request timed out after ${String(timeoutMs)}ms`);
		}
		throw err;
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`halogen returned ${String(response.status)}: ${text.slice(0, 300)}`);
	}
	const json: unknown = await response.json();
	if (!isRecord(json)) throw new Error("halogen returned a non-object response");
	return json;
}

async function classifyQuestion(
	model: ClassifierModel<string>,
	baseUrl: string,
	apiKey: string | undefined,
	systemContent: string,
	question: ClassifierQuestion,
	temperature: number,
	options: ClassifierOptions | undefined,
): Promise<{ answer: ClassifierResult["answers"][string]; usage: Usage }> {
	const { labels, keys } = questionLabels(question);
	const userContent = `${renderTask(question, labels)}\n\n${answerInstruction(question)}`;

	const json = await postChat(
		baseUrl,
		apiKey,
		{
			model: serverModelFor(model),
			messages: [
				{ role: "system", content: systemContent },
				{ role: "user", content: userContent },
				{ role: "assistant", content: ANSWER_PREFIX },
			],
			continue_final_message: true,
			add_generation_prompt: false,
			chat_template_kwargs: { enable_thinking: false },
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: TOP_LOGPROBS,
		},
		options,
	);

	const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
	const content = isRecord(choice) && isRecord(choice.logprobs) ? choice.logprobs.content : undefined;
	const first = Array.isArray(content) ? content[0] : undefined;
	const top = isRecord(first) && Array.isArray(first.top_logprobs) ? first.top_logprobs : undefined;
	if (!top) throw new Error("halogen did not return token log-probabilities");

	const byToken = new Map<string, number>();
	for (const entry of top) {
		if (isRecord(entry) && typeof entry.token === "string" && typeof entry.logprob === "number") {
			byToken.set(entry.token, entry.logprob);
		}
	}

	const present = [...byToken.values()];
	if (present.length === 0) throw new Error("halogen returned an empty top_logprobs list");
	const floor = Math.min(...present) - MISSING_LABEL_DELTA;
	const labelLogprobs = labels.map((l) => (byToken.has(l) ? (byToken.get(l) as number) : floor));
	if (labelLogprobs.every((lp) => lp <= floor)) {
		throw new Error("halogen gave no probability to any answer label");
	}

	const probs = labelProbabilities(labelLogprobs, temperature);

	// Учёт токенов из OpenAI-совместимого блока usage.
	const usageBlock = isRecord(json.usage) ? json.usage : {};
	const details = isRecord(usageBlock.prompt_tokens_details) ? usageBlock.prompt_tokens_details : {};
	const promptTokens = Number(usageBlock.prompt_tokens ?? 0);
	const cached = Number(details.cached_tokens ?? 0);
	const completionTokens = Number(usageBlock.completion_tokens ?? 0);
	const usage: Usage = {
		input: Math.max(0, promptTokens - cached),
		output: completionTokens,
		cacheRead: cached,
		cacheWrite: 0,
		totalTokens: promptTokens + completionTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	usage.cost = computeCost(model.cost, usage);

	return { answer: answerFromProbabilities(question, keys, probs), usage };
}

/**
 * Классификация через узел halogen-flash-server чтением вероятностей следующего
 * токена-метки. Вопросы идут по одному: все делят одно системное сообщение, поэтому
 * сервер прогоняет состояние один раз и переиспользует prompt-кэш.
 */
export const classify = async (
	model: ClassifierModel<string>,
	context: ClassifierContext,
	options?: ClassifierOptions,
): Promise<ClassifierResult> => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (model.api !== CLASSIFIER_API) {
			throw new Error(`Unsupported classifier API: ${String(model.api)}`);
		}
		const temperature = options?.temperature ?? 1;
		if (!(temperature > 0) || !Number.isFinite(temperature)) {
			throw new Error(`Temperature must be a positive number, got ${String(temperature)}`);
		}
		const questions = context.questions ?? {};
		const ids = Object.keys(questions);
		if (ids.length === 0) throw new Error("No questions provided");

		// Валидация всех вопросов до первой сетевой операции.
		for (const id of ids) questionLabels(questions[id] as ClassifierQuestion);

		const baseUrl = normalizeBaseUrl(model.baseUrl);
		const apiKey = options?.apiKey;
		const systemContent = renderSystem(context.state);

		const answers: ClassifierResult["answers"] = {};
		const total = emptyUsage();
		for (const id of ids) {
			const { answer, usage } = await classifyQuestion(
				model,
				baseUrl,
				apiKey,
				systemContent,
				questions[id] as ClassifierQuestion,
				temperature,
				options,
			);
			answers[id] = answer;
			total.input += usage.input;
			total.output += usage.output;
			total.cacheRead += usage.cacheRead;
			total.cacheWrite += usage.cacheWrite;
			total.totalTokens += usage.totalTokens;
		}
		total.cost = computeCost(model.cost, total);
		output.answers = answers;
		output.usage = total;
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		return output;
	}
};
