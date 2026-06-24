import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_LABSPEC_BRIDGE_DIR } from "../../labspec-bridge.ts";
import { createErrorResult, createSuccessResult } from "../../results.ts";
import { artifactUriPath } from "../../run-store.ts";
import type { RamanActiveProbeParams, ToolResult } from "../../schemas.ts";
import { RamanBridgeClient, RamanBridgeRequestError } from "./bridge.ts";

interface RamanActiveProbeContext {
	cwd: string;
	commandId: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function relativeToCwd(cwd: string, path: string): string {
	const result = relative(cwd, path);
	return artifactUriPath(result.startsWith("..") ? path : result);
}

function activeProbeRoot(cwd: string, probeId: string): string {
	return join(cwd, ".pi", "experiment-runs", "maintenance", "active-probes", probeId);
}

function validateActiveProbeRequest(commandId: string, params: RamanActiveProbeParams): ToolResult | undefined {
	if (!params.approval.approved) {
		return createErrorResult(
			commandId,
			"Raman active probe requires explicit operator approval.",
			"hardware_gate_failed",
			["Set approval.approved only after the operator accepts the active probe side effects."],
			{ approval: params.approval },
			true,
		);
	}
	if (params.captureFrame !== true && params.acquireSpectrumSmoke !== true) {
		return createErrorResult(
			commandId,
			"Raman active probe must request at least one active smoke check.",
			"invalid_tool_params",
			["Set captureFrame or acquireSpectrumSmoke to true."],
			{ captureFrame: params.captureFrame, acquireSpectrumSmoke: params.acquireSpectrumSmoke },
			true,
		);
	}
	if (params.acquireSpectrumSmoke === true && params.approval.ramanSafety?.laserPowerConfirmed !== true) {
		return createErrorResult(
			commandId,
			"Raman spectrum smoke probe requires laser power confirmation.",
			"hardware_gate_failed",
			["Confirm laser power in approval.ramanSafety before active spectrum smoke."],
			{ approval: params.approval },
			true,
		);
	}
	return undefined;
}

export async function runRamanActiveProbe(params: RamanActiveProbeParams, ctx: RamanActiveProbeContext): Promise<ToolResult> {
	const invalid = validateActiveProbeRequest(ctx.commandId, params);
	if (invalid) return invalid;

	const probeId = `raman-active-probe-${randomUUID().slice(0, 8)}`;
	const outputDir = params.outputDir ?? activeProbeRoot(ctx.cwd, probeId);
	const labspecBridgeDir = params.labspecBridgeDir ?? DEFAULT_LABSPEC_BRIDGE_DIR;
	const frameBridgeDir = params.frameBridgeDir ?? labspecBridgeDir;
	mkdirSync(outputDir, { recursive: true });
	const recordPath = join(outputDir, "active-probe.json");
	const bridge = new RamanBridgeClient({ cwd: ctx.cwd, python: params.stagePython, requestTimeoutMs: 30_000 });
	try {
		const result = await bridge.request<Record<string, unknown>>("active_probe", {
			outputDir,
			captureFrame: params.captureFrame === true,
			acquireSpectrumSmoke: params.acquireSpectrumSmoke === true,
			frameBackend: params.frameBackend ?? "fake",
			bridgeDir: frameBridgeDir,
			frame: {
				backend: params.frameBackend ?? "fake",
				bridgeDir: frameBridgeDir,
				timeoutMs: params.timeoutS === undefined ? undefined : Math.round(params.timeoutS * 1000),
			},
			acquisition: {
				backend: params.acquisitionBackend ?? "fake",
				bridgeDir: labspecBridgeDir,
				timeoutS: params.timeoutS,
				pollIntervalS: params.pollIntervalS,
				saveFormat: "txt",
			},
		});
		const record = {
			probeId,
			commandId: ctx.commandId,
			createdAt: nowIso(),
			approval: params.approval,
			result,
		};
		writeJson(recordPath, record);
		const bridgeArtifacts = Array.isArray(result.artifacts)
			? result.artifacts
					.filter((artifact): artifact is Record<string, unknown> => typeof artifact === "object" && artifact !== null && !Array.isArray(artifact))
					.map((artifact, index) => ({
						id: `${probeId}-artifact-${index}`,
						uri: typeof artifact.path === "string" ? relativeToCwd(ctx.cwd, artifact.path) : relativeToCwd(ctx.cwd, outputDir),
						label: typeof artifact.kind === "string" ? `Raman active probe ${artifact.kind}` : "Raman active probe artifact",
						kind: typeof artifact.kind === "string" ? artifact.kind : "active-probe-artifact",
					}))
			: [];
		return createSuccessResult(
			ctx.commandId,
			`Raman active probe ${probeId} completed with ${bridgeArtifacts.length} artifact(s).`,
			{ probeId, approval: params.approval, result, recordPath },
			["Review active probe artifacts and record operator approval before hardware execution."],
			[
				{ id: `${probeId}-record`, uri: relativeToCwd(ctx.cwd, recordPath), label: "Raman active probe record", kind: "active-probe" },
				...bridgeArtifacts,
			],
		);
	} catch (error) {
		const stateAfter =
			error instanceof RamanBridgeRequestError
				? { ramanErrorCode: error.code, detail: error.detail }
				: { message: error instanceof Error ? error.message : String(error) };
		return createErrorResult(
			ctx.commandId,
			"Raman active probe failed.",
			"bridge_crashed",
			["Review bridge stderr and active probe side effects before retrying."],
			stateAfter,
			true,
		);
	} finally {
		await bridge.shutdown().catch(() => bridge.close());
	}
}
