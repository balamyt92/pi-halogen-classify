/**
 * Офлайн-тесты чистой логики предохранителя (guard.ts) и слияния guard-секции.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { decideGuard, buildBlockReason, BLOCK_HINTS, fillHint, type GuardDecision } from "../guard.ts";
import { applyEnvOverrides, mergeGuard, DEFAULT_GUARD, mergeConfig, DEFAULT_CONFIG } from "../config.ts";

function choiceResult(choice: string, confidence: number): ClassifierResult {
	return {
		api: "halogen-classify",
		provider: "halogen",
		model: "ms1",
		answers: { risk: { type: "choice", choice, probabilities: {}, confidence } },
		stopReason: "stop",
		timestamp: 0,
	};
}

test("decideGuard: safe never blocks", () => {
	const d = decideGuard(choiceResult("safe", 1.0), 0.5);
	assert.equal(d.block, false);
	assert.equal(d.category, "safe");
});

test("decideGuard: dangerous with confidence >= threshold blocks", () => {
	const d = decideGuard(choiceResult("root_search", 0.99), 0.6);
	assert.equal(d.block, true);
	assert.equal(d.category, "root_search");
});

test("decideGuard: dangerous below threshold does not block", () => {
	const d = decideGuard(choiceResult("destructive", 0.4), 0.6);
	assert.equal(d.block, false);
});

test("decideGuard: unknown / missing answer fails open", () => {
	const empty: ClassifierResult = {
		api: "halogen-classify", provider: "halogen", model: "ms1",
		answers: {}, stopReason: "stop", timestamp: 0,
	};
	assert.equal(decideGuard(empty, 0.5).block, false);
	assert.equal(decideGuard(empty, 0.5).category, "unknown");
});

test("mergeGuard: file fields override defaults", () => {
	const g = mergeGuard({ enabled: true, node: "ms2", blockThreshold: 0.8 }, DEFAULT_GUARD);
	assert.equal(g.enabled, true);
	assert.equal(g.node, "ms2");
	assert.equal(g.blockThreshold, 0.8);
});

test("mergeGuard: invalid or missing fields fall back to defaults", () => {
	assert.deepEqual(mergeGuard(undefined, DEFAULT_GUARD), DEFAULT_GUARD);
	const g = mergeGuard({ enabled: "yes", blockThreshold: 5 }, DEFAULT_GUARD);
	assert.equal(g.enabled, DEFAULT_GUARD.enabled);
	assert.equal(g.blockThreshold, DEFAULT_GUARD.blockThreshold);
});

test("mergeConfig: guard section is merged from file", () => {
	const cfg = mergeConfig({ guard: { enabled: true } }, DEFAULT_CONFIG);
	assert.equal(cfg.guard.enabled, true);
	assert.equal(cfg.guard.node, DEFAULT_GUARD.node);
});

test("mergeGuard: blockHint accepts a custom string and an explicit empty string", () => {
	assert.equal(mergeGuard({ blockHint: "custom {category}" }, DEFAULT_GUARD).blockHint, "custom {category}");
	assert.equal(mergeGuard({ blockHint: "" }, DEFAULT_GUARD).blockHint, "");
	assert.equal(mergeGuard({ blockHint: 42 }, DEFAULT_GUARD).blockHint, DEFAULT_GUARD.blockHint);
});

test("applyEnvOverrides: HALOGEN_GUARD_HINT overrides and empty value disables the hint", () => {
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, { HALOGEN_GUARD_HINT: "ru {category}" }).guard.blockHint, "ru {category}");
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, { HALOGEN_GUARD_HINT: "" }).guard.blockHint, "");
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, {}).guard.blockHint, DEFAULT_GUARD.blockHint);
});

const destructive: GuardDecision = { block: true, category: "destructive", confidence: 0.92 };

test("buildBlockReason: head carries category and confidence, no command echo", () => {
	assert.equal(
		buildBlockReason(destructive, "x").split("\n")[0],
		"halogen guard: blocked (category: destructive, confidence: 0.92)",
	);
});

test("buildBlockReason: default hint tells the agent to ask the user", () => {
	assert.match(buildBlockReason(destructive), /ask the user to run it themselves/);
	assert.match(buildBlockReason({ ...destructive, category: "privileged" }), /ask the user to run it themselves/);
});

test("buildBlockReason: root_search hint narrows the path instead of asking", () => {
	assert.match(buildBlockReason({ ...destructive, category: "root_search" }), /Restrict the search to the project directory/);
});

test("buildBlockReason: unknown category falls back to the generic hint", () => {
	assert.equal(buildBlockReason({ ...destructive, category: "nope" }).split("\n")[1], BLOCK_HINTS.unknown);
});

test("buildBlockReason: custom hint replaces the default and substitutes {category}", () => {
	assert.equal(
		buildBlockReason(destructive, "custom: {category}"),
		"halogen guard: blocked (category: destructive, confidence: 0.92)\ncustom: destructive",
	);
	assert.equal(fillHint("{category}/{category}", "safe"), "safe/safe");
});

test("buildBlockReason: empty or whitespace hint drops the hint line", () => {
	assert.ok(!buildBlockReason(destructive, "   ").includes("\n"));
});
