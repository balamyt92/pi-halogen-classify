/**
 * Тесты сборки запроса в classify.ts: раскладка сообщений проверяется через
 * подставной fetch, без сети.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import { classify } from "../classify.ts";

const MODEL = {
	id: "ms1",
	name: "ms1",
	api: "halogen-classify",
	provider: "halogen",
	baseUrl: "http://node.invalid/v1",
	type: "classifier",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
} as unknown as ClassifierModel<string>;

const RISK = {
	type: "choice",
	instructions: "Classify the risk of this shell command.",
	criteria: {
		safe: "Ordinary developer work inside a project",
		root_search: "Recursive search from the filesystem root",
		destructive: "Mass or forced deletion or overwrite",
		privileged: "Privilege escalation or system config change",
	},
} as const;

/** Ответ узла: вся масса на метке `A`. */
function fakeFetch(capture: Record<string, unknown>[]): typeof globalThis.fetch {
	return (async (_url: unknown, init?: RequestInit) => {
		capture.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return new Response(
			JSON.stringify({
				choices: [
					{
						logprobs: {
							content: [
								{
									token: "A",
									logprob: -0.01,
									top_logprobs: [
										{ token: "A", logprob: -0.01 },
										{ token: "B", logprob: -9 },
									],
								},
							],
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 1 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof globalThis.fetch;
}

function messagesOf(body: Record<string, unknown>) {
	const messages = body.messages as { role: string; content: string }[];
	return messages.map((m) => m.role).join(",");
}

test("classify: guard-shaped call puts the state in user", async () => {
	const captured: Record<string, unknown>[] = [];
	const context: ClassifierContext = {
		state: { command: "find / -name '*.env' 2>/dev/null" },
		questions: { risk: RISK as never },
	};
	const result = await classify(MODEL, context, { fetch: fakeFetch(captured) });
	assert.equal(result.stopReason, "stop");
	assert.equal(captured.length, 1);
	const body = captured[0]!;
	const messages = body.messages as { role: string; content: string }[];
	assert.equal(messagesOf(body), "system,user,assistant");
	assert.ok(!messages[0]!.content.includes("2>/dev/null"), "команды в system быть не должно");
	assert.match(messages[1]!.content, /2>\/dev\/null/);
	assert.match(messages[0]!.content, /root_search/);
});

test("classify: several questions keep the state in system", async () => {
	const captured: Record<string, unknown>[] = [];
	const context: ClassifierContext = {
		state: { contract: "x".repeat(2000) },
		questions: { a: RISK as never, b: RISK as never },
	};
	const result = await classify(MODEL, context, { fetch: fakeFetch(captured) });
	assert.equal(result.stopReason, "stop");
	assert.equal(captured.length, 2);
	for (const body of captured) {
		const messages = body.messages as { role: string; content: string }[];
		assert.match(messages[0]!.content, /xxxx/, "состояние в общем системном сообщении");
		assert.match(messages[1]!.content, /Options:/);
	}
	// Системное сообщение одинаково на всех вопросах — его и держит кэш узла.
	const first = (captured[0]!.messages as { content: string }[])[0]!.content;
	const second = (captured[1]!.messages as { content: string }[])[0]!.content;
	assert.equal(first, second);
});

test("classify: one question with a large state keeps the state in system", async () => {
	const captured: Record<string, unknown>[] = [];
	const context: ClassifierContext = {
		state: { contract: "y".repeat(2000) },
		questions: { a: RISK as never },
	};
	await classify(MODEL, context, { fetch: fakeFetch(captured) });
	const messages = captured[0]!.messages as { role: string; content: string }[];
	assert.match(messages[0]!.content, /yyyy/);
	assert.match(messages[1]!.content, /Options:/);
});
