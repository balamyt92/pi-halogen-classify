/**
 * Офлайн-тесты чистой логики из labels.ts. Сеть не нужна.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import {
	answerFromProbabilities,
	answerInstruction,
	BOOL_LABELS,
	labelProbabilities,
	peakConfidence,
	pickLayout,
	questionLabels,
	renderMessages,
	renderQuestionText,
	renderStateBlock,
	renderSystem,
	renderTask,
	STATE_LAST_TAIL,
} from "../labels.ts";

test("questionLabels: choice maps letters to keys in order", () => {
	const q: ClassifierQuestion = {
		type: "choice",
		instructions: "x",
		criteria: { bug: "b", feature: "f", question: "q" },
	};
	const { labels, keys } = questionLabels(q);
	assert.deepEqual(labels, ["A", "B", "C"]);
	assert.deepEqual(keys, ["bug", "feature", "question"]);
});

test("questionLabels: choice needs 2..62 options", () => {
	assert.throws(
		() => questionLabels({ type: "choice", instructions: "x", criteria: { only: "a" } }),
		/needs 2 to/,
	);
	const many = Object.fromEntries(
		Array.from({ length: 63 }, (_, i) => [`k${i}`, "v"]),
	);
	assert.throws(
		() => questionLabels({ type: "choice", instructions: "x", criteria: many }),
		/needs 2 to 62 options, got 63/,
	);
});

test("questionLabels: bool uses A/No and true/false keys", () => {
	const q: ClassifierQuestion = {
		type: "bool",
		instructions: "x",
		criteria: { true: "yes", false: "no" },
	};
	const { labels, keys } = questionLabels(q);
	assert.deepEqual(labels, BOOL_LABELS);
	assert.deepEqual(keys, ["true", "false"]);
});

test("questionLabels: score uses digit labels and needs 2..10 levels", () => {
	const q: ClassifierQuestion = {
		type: "score",
		instructions: "x",
		criteria: ["a", "b", "c"],
	};
	const { labels, keys } = questionLabels(q);
	assert.deepEqual(labels, ["0", "1", "2"]);
	assert.deepEqual(keys, ["0", "1", "2"]);
	assert.throws(
		() => questionLabels({ type: "score", instructions: "x", criteria: ["one"] }),
		/needs 2 to 10 levels/,
	);
});

test("renderTask: choice lists labeled options", () => {
	const q: ClassifierQuestion = {
		type: "choice",
		instructions: "Pick one",
		criteria: { bug: "defect", feature: "request" },
	};
	const out = renderTask(q, ["A", "B"]);
	assert.match(out, /Question: Pick one/);
	assert.match(out, /A\. bug: defect/);
	assert.match(out, /B\. feature: request/);
});

test("renderTask: bool renders A=Yes / B=No with meanings", () => {
	const q: ClassifierQuestion = {
		type: "bool",
		instructions: "Urgent?",
		criteria: { true: "immediate", false: "can wait" },
	};
	const out = renderTask(q, BOOL_LABELS);
	assert.match(out, /A\. Yes — immediate/);
	assert.match(out, /B\. No — can wait/);
});

test("answerInstruction: per type", () => {
	assert.equal(answerInstruction({ type: "choice", instructions: "x", criteria: {} }), "Answer with one letter.");
	assert.equal(answerInstruction({ type: "score", instructions: "x", criteria: [] }), "Answer with one level number.");
	assert.match(
		answerInstruction({ type: "bool", instructions: "x", criteria: { true: "", false: "" } }),
		/Answer A for yes, B for no\./,
	);
});

test("renderSystem: includes the state JSON", () => {
	const out = renderSystem({ a: 1, b: "two" });
	assert.match(out, /State:/);
	assert.match(out, /"a": 1/);
	assert.match(out, /"b": "two"/);
});

const GUARD_LIKE: ClassifierQuestion = {
	type: "choice",
	instructions: "Classify the risk of this shell command.",
	criteria: {
		safe: "Ordinary developer work inside a project",
		root_search: "Recursive search from the filesystem root",
		destructive: "Mass or forced deletion or overwrite",
		privileged: "Privilege escalation or system config change",
	},
};

test("renderQuestionText: task plus the answer instruction", () => {
	const out = renderQuestionText(GUARD_LIKE);
	assert.match(out, /Options:\nA\. safe:/);
	assert.match(out, /Answer with one letter\.$/);
});

test("renderMessages state-first: same strings as renderSystem + renderQuestionText", () => {
	const state = { command: "git status" };
	const parts = renderMessages(state, GUARD_LIKE, "state-first");
	assert.equal(parts.system, renderSystem(state));
	assert.equal(parts.user, renderQuestionText(GUARD_LIKE));
	assert.match(parts.system, /git status/);
});

test("renderMessages state-last: criteria in system, state in user", () => {
	const state = { command: "rm -rf dist" };
	const parts = renderMessages(state, GUARD_LIKE, "state-last");
	assert.ok(!parts.system.includes("rm -rf dist"), "system must not carry the state");
	assert.match(parts.system, /A\. safe:/);
	assert.match(parts.system, new RegExp(STATE_LAST_TAIL));
	assert.equal(parts.user, renderStateBlock(state));
	assert.match(parts.user, /rm -rf dist/);
});

test("pickLayout: several questions keep the state in system", () => {
	assert.equal(pickLayout({ command: "ls" }, [GUARD_LIKE, GUARD_LIKE]), "state-first");
});

test("pickLayout: one question with a short state puts it last", () => {
	assert.equal(pickLayout({ command: "git status" }, [GUARD_LIKE]), "state-last");
});

test("pickLayout: one question with a large state keeps it first", () => {
	const bigState = { document: "x".repeat(renderQuestionText(GUARD_LIKE).length + 10) };
	assert.equal(pickLayout(bigState, [GUARD_LIKE]), "state-first");
});

test("pickLayout: no questions falls back to state-first", () => {
	assert.equal(pickLayout({}, []), "state-first");
});

test("labelProbabilities: sums to 1 and preserves order", () => {
	const p = labelProbabilities([-1, -2, -3], 1);
	const sum = p.reduce((s, x) => s + x, 0);
	assert.ok(Math.abs(sum - 1) < 1e-9);
	assert.ok(p[0] > p[1] && p[1] > p[2]);
});

test("labelProbabilities: temperature > 1 flattens, < 1 sharpens", () => {
	const base = labelProbabilities([-1, -2], 1);
	const flat = labelProbabilities([-1, -2], 4);
	const sharp = labelProbabilities([-1, -2], 0.25);
	assert.ok(flat[0] < base[0], "higher temperature lowers the top probability");
	assert.ok(sharp[0] > base[0], "lower temperature raises the top probability");
});

test("peakConfidence: uniform -> 0, one-hot -> 1", () => {
	assert.ok(Math.abs(peakConfidence([0.5, 0.5])) < 1e-9);
	assert.ok(Math.abs(peakConfidence([1, 0, 0]) - 1) < 1e-9);
});

test("answerFromProbabilities: bool returns P(true)", () => {
	const q: ClassifierQuestion = { type: "bool", instructions: "x", criteria: { true: "", false: "" } };
	const a = answerFromProbabilities(q, ["true", "false"], [0.8, 0.2]);
	assert.equal(a.type, "bool");
	assert.ok(a.type === "bool" && Math.abs(a.probability - 0.8) < 1e-9);
});

test("answerFromProbabilities: choice picks argmax and maps to key", () => {
	const q: ClassifierQuestion = {
		type: "choice",
		instructions: "x",
		criteria: { bug: "", feature: "", question: "" },
	};
	const a = answerFromProbabilities(q, ["bug", "feature", "question"], [0.1, 0.7, 0.2]);
	assert.equal(a.type, "choice");
	if (a.type === "choice") {
		assert.equal(a.choice, "feature");
		assert.equal(a.probabilities.feature, 0.7);
		assert.ok(a.confidence > 0 && a.confidence <= 1);
	}
});

test("answerFromProbabilities: score is the expected value over levels", () => {
	const q: ClassifierQuestion = { type: "score", instructions: "x", criteria: ["0", "1", "2", "3"] };
	const a = answerFromProbabilities(q, ["0", "1", "2", "3"], [0.1, 0.2, 0.6, 0.1]);
	assert.equal(a.type, "score");
	// 0*0.1 + 1*0.2 + 2*0.6 + 3*0.1 = 1.7
	if (a.type === "score") {
		assert.ok(Math.abs(a.score - 1.7) < 1e-9);
	}
});
