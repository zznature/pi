import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HardwarePilotParams } from "../schemas.ts";
import type { ExperimentPoint } from "../spec-utils.ts";

export interface StagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

export interface StageVisit {
	before: StagePosition;
	after: StagePosition;
}

export interface StageAdapter {
	/**
	 * Atomically move to a single point and wait for it to settle. Returns the
	 * positions read immediately before and after the move. Implementations must
	 * keep all controller state (last target, enabled channel, serial session)
	 * inside this one call so that the move and the settle wait cannot be split
	 * across separate hardware sessions.
	 */
	visitPoint(point: ExperimentPoint, settleTimeoutMs: number): StageVisit;
	stop(): void;
	close(): void;
}

export class MemoryStageAdapter implements StageAdapter {
	private position: StagePosition = { xUm: 0, yUm: 0, zUm: 0 };
	readonly history: StagePosition[] = [this.position];
	stopped = false;

	visitPoint(point: ExperimentPoint, _settleTimeoutMs: number): StageVisit {
		const before = this.position;
		this.position = {
			xUm: point.xUm,
			yUm: point.yUm,
			zUm: point.zUm ?? this.position.zUm,
		};
		this.history.push(this.position);
		return { before, after: this.position };
	}

	stop(): void {
		this.stopped = true;
	}

	close(): void {}
}

export class PythonMCNewtonStageAdapter implements StageAdapter {
	private readonly bridgePath: string;
	private readonly port: string;
	private readonly cwd: string;
	private readonly python: string;

	constructor(port: string, cwd: string, python: string = "python") {
		this.port = port;
		this.cwd = cwd;
		this.python = python;
		const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
		this.bridgePath = join(extensionDir, "stage_bridge.py");
	}

	visitPoint(point: ExperimentPoint, settleTimeoutMs: number): StageVisit {
		const output = this.callBridge(
			"visit",
			{ xUm: point.xUm, yUm: point.yUm, zUm: point.zUm ?? null, settleTimeoutMs },
			settleTimeoutMs + 30_000,
		);
		return JSON.parse(output) as StageVisit;
	}

	stop(): void {
		this.callBridge("stop", {}, 30_000);
	}

	close(): void {}

	private callBridge(action: string, payload: Record<string, unknown>, timeoutMs: number): string {
		const result = spawnSync(
			this.python,
			[
				this.bridgePath,
				"--stage-root",
				resolve(this.cwd, "docs", "Raman"),
				"--port",
				this.port,
				"--action",
				action,
				"--payload",
				JSON.stringify(payload),
			],
			{ cwd: this.cwd, encoding: "utf-8", timeout: timeoutMs },
		);
		if (result.error) {
			throw new Error(`stage bridge process failed: ${result.error.message}`);
		}
		if (result.status === 0) return result.stdout.trim();
		const stderr = result.stderr.trim();
		throw new Error(stderr || `stage bridge failed with status ${result.status}`);
	}
}

export function createStageAdapter(params: HardwarePilotParams, cwd: string): StageAdapter {
	if (params.stageAdapter === "memory") return new MemoryStageAdapter();
	if (!params.stagePort) {
		throw new Error("stagePort is required for mc_newton_xyz stage adapter");
	}
	return new PythonMCNewtonStageAdapter(params.stagePort, cwd, params.stagePython);
}
