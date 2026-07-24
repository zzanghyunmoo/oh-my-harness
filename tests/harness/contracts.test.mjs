import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertSecretFree,
	canonicalSha256,
} from "../../scripts/harness/canonical.mjs";
import { validateSchema as validate } from "../../scripts/harness/schema.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT_ROOT = join(REPO_ROOT, "harness", "contracts");
const PROFILE_PATH = join(
	REPO_ROOT,
	"harness",
	"profiles",
	"personal-v1.profile.json",
);
const CONTRACT_FILES = {
	profile: "harness-profile.schema.json",
	feature: "feature-contract.schema.json",
	adapter: "runtime-adapter.schema.json",
	result: "conformance-result.schema.json",
};
const SHA256 = "a".repeat(64);
const EVIDENCE_KEYS = [
	"source",
	"runtime",
	"overlay",
	"featureContract",
	"fixture",
	"oracle",
	"provider",
	"coordinator",
];
const TERMINAL_STATUSES = [
	"passed",
	"failed",
	"blocked",
	"timeout",
	"cancelled",
	"infra-error",
	"not-run",
	"expired",
];
const REQUIRED_SCENARIOS = [
	"discovery-invocation",
	"scripted-interaction",
	"artifact",
	"handoff",
	"approval-safety",
	"expected-failure",
	"evidence-oracle",
];

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

let contractCache;
function loadContracts() {
	contractCache ??= Object.fromEntries(
		Object.entries(CONTRACT_FILES).map(([id, file]) => [
			id,
			readJson(join(CONTRACT_ROOT, file)),
		]),
	);
	return contractCache;
}

function featureFixture() {
	return {
		$schema: "../contracts/feature-contract.schema.json",
		schemaVersion: "1.0.0",
		id: "ce-plan",
		source: {
			inventoryRef: "../inventory/compound-engineering-v3.19.0.json",
			featureId: "ce-plan",
		},
		workflow: {
			artifacts: [
				{ id: "requirements", kind: "input", required: true },
				{ id: "plan", kind: "output", required: true },
			],
			steps: [
				{
					id: "plan",
					inputRefs: ["requirements"],
					outputRefs: ["plan"],
					handoffRefs: ["work"],
				},
			],
			handoffs: [{ id: "work", fromStep: "plan", artifactRefs: ["plan"] }],
		},
		capabilities: {
			required: [
				{
					id: "filesystem-write",
					readiness: ["ready"],
					safetyClass: "local-configuration",
				},
			],
			optional: [
				{
					id: "blocking-question",
					readiness: [
						"hidden-by-mode",
						"not-configured",
						"ready",
						"runtime-gated",
						"setup-only",
						"unavailable-by-auth",
					],
					safetyClass: "local-configuration",
				},
			],
		},
		safety: {
			sideEffectClass: "local-write",
			approval: "none",
			failureBoundary: "before-side-effect",
		},
		requiredScenarios: REQUIRED_SCENARIOS,
		expectedFailures: ["blocked", "timeout", "cancelled", "infra-error"],
		evidenceOracle: {
			id: "plan-artifact-v1",
			kind: "structural",
			version: "1.0.0",
		},
	};
}

function adapterFixture() {
	const lifecycle = (operation) => ({
		executableId: "harness-lifecycle",
		tokens: [{ kind: "literal", value: operation }, { kind: "placeholder", id: "payload-root" }],
	});
	const platforms = [
		{ id: "darwin-arm64-personal", os: "darwin", architecture: "arm64" },
		{ id: "darwin-x64-release", os: "darwin", architecture: "x64" },
		{ id: "linux-x64-release", os: "linux", architecture: "x64" },
		{ id: "win32-arm64-release", os: "win32", architecture: "arm64" },
		{ id: "win32-x64-release", os: "win32", architecture: "x64" },
	];
	return {
		$schema: "../contracts/runtime-adapter.schema.json",
		schemaVersion: "1.1.0",
		id: "opencode",
		runtime: { name: "opencode", version: "1.18.0" },
		platforms: platforms.map(({ id, os, architecture }) => ({
			id,
			os,
			architecture,
			variant: os === "win32" ? "windows" : os === "darwin" ? "darwin" : "baseline-glibc",
			executable: {
				id: "runtime",
				memberPath: os === "win32" ? "opencode.exe" : "opencode",
				sha256: SHA256,
			},
			acquisition: {
				kind: "release-archive", provider: "github", owner: "anomalyco", repository: "opencode", tag: "v1.18.0",
				asset: { id: 1, name: `opencode-${id}.zip`, apiUrl: "https://api.github.com/repos/anomalyco/opencode/releases/assets/1", downloadUrl: `https://github.com/anomalyco/opencode/releases/download/v1.18.0/opencode-${id}.zip`, sha256: "b".repeat(64) },
			},
		})),
		native: {
			install: lifecycle("install-native-payload"),
			discovery: lifecycle("verify-native-discovery"),
			invocation: { executableId: "runtime", tokens: [{ kind: "literal", value: "run" }, { kind: "literal", value: "--format" }, { kind: "literal", value: "json" }] },
			preModelGate: {
				kind: "extension-hook", phase: "pre-model", surfaceId: "experimental.chat.system.transform", configurationScope: "project-plugin", status: "candidate",
				sourceRef: { owner: "anomalyco", repository: "opencode", commit: "a".repeat(40), locations: ["packages/plugin/src/index.ts::Hooks[\"experimental.chat.system.transform\"]"] },
			},
			headlessEvidence: { protocol: "json", version: "1.0.0" },
		},
		companions: [],
		optionalExtensions: [],
	};
}

function resultFixture({
	terminalStatus = "passed",
	countsAsPass = terminalStatus === "passed",
	tier = "hermetic",
} = {}) {
	const result = {
		$schema: "../contracts/conformance-result.schema.json",
		schemaVersion: "1.0.0",
		cell: {
			profileId: "personal-v1",
			featureId: "ce-plan",
			runtimeId: "opencode",
			platformId: "linux-x64-release",
			attempt: 1,
		},
		tier,
		terminalStatus,
		countsAsPass,
		terminalReason:
			terminalStatus === "passed" ? "completed" : `terminal-${terminalStatus}`,
		execution: {
			runtimeVersion: "1.18.0",
			os: "linux",
			architecture: "x64",
			executableSha256: SHA256,
			acquisitionIdentity: "github:anomalyco/opencode@v1.18.0",
		},
		evidenceIdentity: Object.fromEntries(
			EVIDENCE_KEYS.map((key, index) => [key, index.toString(16).repeat(64)]),
		),
		artifacts: [
			{
				id: "result",
				path: "evidence/result.json",
				sha256: SHA256,
				redacted: true,
			},
		],
		reproduction: {
			fixtureId: "plan-work-review-v1",
			argv: ["npm", "run", "harness:conformance"],
			workspaceSha256: SHA256,
		},
	};
	if (tier === "hosted") {
		result.certification = {
			targetFingerprint: "service:fixture:read-only",
			expiresAt: "2026-07-17T00:00:00Z",
		};
	}
	return result;
}

function validateFeatureReferences(feature) {
	assert.equal(feature.source.featureId, feature.id, "source feature ID must match contract ID");
	const artifactIds = feature.workflow.artifacts.map(({ id }) => id);
	const stepIds = feature.workflow.steps.map(({ id }) => id);
	const handoffIds = feature.workflow.handoffs.map(({ id }) => id);
	for (const [label, ids] of [
		["artifact", artifactIds],
		["step", stepIds],
		["handoff", handoffIds],
	]) {
		assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
	}
	for (const step of feature.workflow.steps) {
		for (const ref of [...step.inputRefs, ...step.outputRefs]) {
			assert.ok(artifactIds.includes(ref), `${step.id} references unknown artifact ${ref}`);
		}
		for (const ref of step.handoffRefs) {
			assert.ok(handoffIds.includes(ref), `${step.id} references unknown handoff ${ref}`);
		}
	}
	for (const handoff of feature.workflow.handoffs) {
		assert.ok(stepIds.includes(handoff.fromStep), `${handoff.id} references unknown step`);
		for (const ref of handoff.artifactRefs) {
			assert.ok(artifactIds.includes(ref), `${handoff.id} references unknown artifact ${ref}`);
		}
	}
	const capabilityIds = [
		...feature.capabilities.required,
		...feature.capabilities.optional,
	].map(({ id }) => id);
	assert.equal(new Set(capabilityIds).size, capabilityIds.length, "capability IDs must be unique");
	for (const capability of feature.capabilities.required) {
		assert.deepEqual(capability.readiness, ["ready"], `${capability.id} must require ready`);
	}
}

function validateProfileReferences(profile) {
	const platformIds = profile.platforms.map(({ id }) => id);
	const runtimeIds = profile.runtimes.map(({ id }) => id);
	assert.equal(
		new Set(platformIds).size,
		platformIds.length,
		"platform IDs must be unique",
	);
	assert.equal(
		new Set(runtimeIds).size,
		runtimeIds.length,
		"runtime IDs must be unique",
	);
	assert.deepEqual(profile.ownership, {
		upstreamPayload: "upstream",
		sourceReceipt: "harness",
		generatedCore: "harness",
		projectOverlay: "project",
		nativeLifecycle: "runtime",
		personalConfiguration: "user",
	});
	assert.deepEqual(
		Object.fromEntries(profile.platforms.map(({ id, os, architecture, lane }) => [id, { os, architecture, lane }])),
		{
			"darwin-arm64-personal": { os: "darwin", architecture: "arm64", lane: "personal-certification" },
			"darwin-x64-release": { os: "darwin", architecture: "x64", lane: "hermetic-release" },
			"linux-x64-release": { os: "linux", architecture: "x64", lane: "hermetic-release" },
			"win32-arm64-release": { os: "win32", architecture: "arm64", lane: "hermetic-release" },
			"win32-x64-release": { os: "win32", architecture: "x64", lane: "hermetic-release" },
		},
	);
	assert.deepEqual(profile.tiers, {
		hermetic: { required: true, platformRef: "linux-x64-release", resultTier: "hermetic" },
		personal: { required: true, platformRef: "darwin-arm64-personal", resultTier: "personal" },
		hosted: { required: false, resultTier: "hosted", defaultStatus: "not-run" },
	});
	for (const runtime of profile.runtimes) {
		assert.deepEqual(
			runtime.platformRefs,
			[...runtime.platformRefs].sort(),
			`${runtime.id} platform refs must be sorted`,
		);
		for (const ref of runtime.platformRefs)
			assert.ok(
				platformIds.includes(ref),
				`${runtime.id} references unknown platform ${ref}`,
			);
		assert.equal(runtime.descriptorRef, `../adapters/${runtime.id}.json`);
	}

	const expectedVersions = {
		"claude-code": "2.1.210",
		codex: "0.144.4",
		opencode: "1.18.0",
	};
	assert.deepEqual(
		Object.fromEntries(
			profile.runtimes.map(({ id, version }) => [id, version]),
		),
		expectedVersions,
	);
	for (const runtime of profile.runtimes) {
		assert.deepEqual(runtime.companions, [], `${runtime.id} has no companion`);
	}

	const lock = readJson(
		join(
			REPO_ROOT,
			"harness",
			"locks",
			"compound-engineering-v3.19.0.lock.json",
		),
	);
	assert.equal(profile.source.tag, lock.source.tag);
	assert.equal(profile.source.commit, lock.source.commit);
	assert.equal(profile.source.tree, lock.source.tree);
	assert.equal(
		profile.source.lockRef,
		"../locks/compound-engineering-v3.19.0.lock.json",
	);
	assert.equal(
		profile.source.inventoryRef,
		"../inventory/compound-engineering-v3.19.0.json",
	);
}

test("U2 contracts and personal profile are present, closed, and secret-free", () => {
	const contracts = loadContracts();
	const profile = readJson(PROFILE_PATH);
	const schemaIds = new Set();
	for (const [id, schema] of Object.entries(contracts)) {
		assert.equal(
			schema.$schema,
			"https://json-schema.org/draft/2020-12/schema",
			`${id} draft`,
		);
		assert.equal(
			schema.$id,
			`https://github.com/zzanghyunmoo/oh-my-harness/blob/main/harness/contracts/${CONTRACT_FILES[id]}`,
			`${id} stable schema ID`,
		);
		schemaIds.add(schema.$id);
		assert.equal(schema.type, "object", `${id} root type`);
		assert.equal(
			schema.additionalProperties,
			false,
			`${id} root must be closed`,
		);
		for (const [definitionId, definition] of Object.entries(schema.$defs ?? {})) {
			if (definition.type === "object") {
				assert.equal(
					definition.additionalProperties,
					false,
					`${id}.${definitionId} must be closed`,
				);
			}
		}
		assertSecretFree(schema);
	}
	assert.equal(schemaIds.size, Object.keys(contracts).length, "schema IDs must be unique");
	assertSecretFree(profile);
	validate(profile, contracts.profile);
	validateProfileReferences(profile);
});

test("feature contract separates required capabilities and complete scenario kinds", () => {
	const schema = loadContracts().feature;
	const fixture = featureFixture();
	assert.doesNotThrow(() => validate(fixture, schema));
	assert.doesNotThrow(() => validateFeatureReferences(fixture));
	assert.notDeepEqual(
		fixture.capabilities.required,
		fixture.capabilities.optional,
	);

	const missingScenario = structuredClone(fixture);
	missingScenario.requiredScenarios.pop();
	assert.throws(() => validate(missingScenario, schema), /contained item/);

	const unknownArtifact = structuredClone(fixture);
	unknownArtifact.workflow.steps[0].outputRefs = ["unknown-artifact"];
	assert.throws(() => validateFeatureReferences(unknownArtifact), /unknown artifact/);

	const invalidReadiness = structuredClone(fixture);
	invalidReadiness.capabilities.required[0].readiness = ["available"];
	assert.throws(() => validate(invalidReadiness, schema), /schema enum/);
	const nonReadyRequiredCapability = structuredClone(fixture);
	nonReadyRequiredCapability.capabilities.required[0].readiness = ["not-configured"];
	assert.throws(() => validate(nonReadyRequiredCapability, schema), /schema const/);

	const runtimeSyntax = structuredClone(fixture);
	runtimeSyntax.command = "runtime /ce-plan";
	assert.throws(() => validate(runtimeSyntax, schema), /additional field/);
});

test("runtime adapter contract requires immutable tuples and structured native surfaces", () => {
	const schema = loadContracts().adapter;
	const fixture = adapterFixture();
	assert.doesNotThrow(() => validate(fixture, schema));

	const missingGate = structuredClone(fixture);
	delete missingGate.native.preModelGate;
	assert.throws(() => validate(missingGate, schema), /required field/);

	const shellCommand = structuredClone(fixture);
	shellCommand.native.invocation.argv = ["opencode run --format json"];
	assert.throws(() => validate(shellCommand, schema), /additional field/);

	const legacy = structuredClone(fixture);
	legacy.schemaVersion = "1.0.0";
	assert.throws(() => validate(legacy, schema), /schema const/);

	const optionalWithoutFallback = structuredClone(fixture);
	optionalWithoutFallback.companions = [
		{ id: "optional-companion", version: "1.0.0", required: false },
	];
	assert.throws(() => validate(optionalWithoutFallback, schema), /required field/);

	const copiedSkill = structuredClone(fixture);
	copiedSkill.skillBody = "forbidden";
	assert.throws(() => validate(copiedSkill, schema), /additional field/);
});

test("terminal statuses cannot forge pass accounting", () => {
	const schema = loadContracts().result;
	for (const status of TERMINAL_STATUSES) {
		assert.doesNotThrow(
			() => validate(resultFixture({ terminalStatus: status }), schema),
			status,
		);
		if (status !== "passed") {
			assert.throws(
				() =>
					validate(
						resultFixture({ terminalStatus: status, countsAsPass: true }),
						schema,
					),
				/schema const/,
			);
		}
	}
	assert.doesNotThrow(() =>
		validate(
			resultFixture({ terminalStatus: "not-run", tier: "hosted" }),
			schema,
		),
	);
	assert.doesNotThrow(() =>
		validate(resultFixture({ terminalStatus: "passed", tier: "hosted" }), schema),
	);
	const hostedWithoutCertification = resultFixture({
		terminalStatus: "passed",
		tier: "hosted",
	});
	delete hostedWithoutCertification.certification;
	assert.throws(
		() => validate(hostedWithoutCertification, schema),
		/required field/,
	);
	const mixedTier = resultFixture();
	mixedTier.certification = {
		targetFingerprint: "service:fixture:read-only",
		expiresAt: "2026-07-17T00:00:00Z",
	};
	assert.throws(() => validate(mixedTier, schema), /schema const/);
});

test("evidence identity requires every digest and changes on one-field mutation", () => {
	const schema = loadContracts().result;
	const fixture = resultFixture();
	const baseline = canonicalSha256(fixture.evidenceIdentity);
	for (const key of EVIDENCE_KEYS) {
		const mutated = structuredClone(fixture);
		mutated.evidenceIdentity[key] = "f".repeat(64);
		assert.notEqual(canonicalSha256(mutated.evidenceIdentity), baseline, key);

		const missing = structuredClone(fixture);
		delete missing.evidenceIdentity[key];
		assert.throws(() => validate(missing, schema), /required field/, key);
	}
});

test("personal profile rejects duplicate and unknown stable references", () => {
	const profile = readJson(PROFILE_PATH);
	const duplicate = structuredClone(profile);
	duplicate.platforms.push(structuredClone(duplicate.platforms[0]));
	assert.throws(() => validateProfileReferences(duplicate), /unique/);

	const unknown = structuredClone(profile);
	unknown.runtimes[0].platformRefs = ["unknown-platform"];
	assert.throws(() => validateProfileReferences(unknown), /unknown platform/);

	const wrongSource = structuredClone(profile);
	wrongSource.source.commit = "f".repeat(40);
	assert.throws(() => validateProfileReferences(wrongSource));

	const optionalWithoutFallback = structuredClone(profile);
	optionalWithoutFallback.runtimes[0].companions = [
		{ id: "optional-companion", version: "1.0.0", required: false },
	];
	assert.throws(
		() => validate(optionalWithoutFallback, loadContracts().profile),
		/required field/,
	);

	const mixedTier = structuredClone(profile);
	mixedTier.tiers.hermetic.resultTier = "hosted";
	assert.throws(() => validate(mixedTier, loadContracts().profile), /schema const/);
});
