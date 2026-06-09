import { existsSync, readFileSync } from "node:fs";

export type WatchdogIntent = "none" | "pause" | "abort" | "request_operator";

export interface WatchdogState {
	nowMs: number;
	lastHeartbeatMs: number;
	heartbeatTimeoutMs: number;
	consecutiveErrors: number;
	maxConsecutiveErrors: number;
	intentsPath?: string;
	qualityMetrics?: WatchdogQualityMetric[];
	artifactGuard?: {
		expectedAtLeast: number;
		actual: number;
	};
	budgetGuard?: {
		completedUnits: number;
		maxUnits: number;
		pauseAtRatio?: number;
	};
}

export interface WatchdogDecision {
	intent: WatchdogIntent;
	reason?: string;
}

export interface WatchdogQualityMetric {
	name: string;
	value: number;
	baseline: number;
	minRatio?: number;
}

function readLatestOperatorIntent(path: string | undefined): WatchdogDecision | undefined {
	if (!path || !existsSync(path)) return undefined;
	const lines = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	for (const line of lines.reverse()) {
		let parsed: { type?: unknown; intent?: unknown; reason?: unknown };
		try {
			parsed = JSON.parse(line) as { type?: unknown; intent?: unknown; reason?: unknown };
		} catch {
			continue;
		}
		const intent = typeof parsed.intent === "string" ? parsed.intent : parsed.type;
		if (intent === "abort" || intent === "pause" || intent === "request_operator") {
			return {
				intent,
				reason: typeof parsed.reason === "string" ? parsed.reason : `operator ${intent}`,
			};
		}
	}
	return undefined;
}

export function evaluateWatchdog(state: WatchdogState): WatchdogDecision {
	const operatorIntent = readLatestOperatorIntent(state.intentsPath);
	if (operatorIntent) return operatorIntent;

	if (state.nowMs - state.lastHeartbeatMs > state.heartbeatTimeoutMs) {
		return { intent: "abort", reason: "heartbeat timeout" };
	}

	if (state.consecutiveErrors >= state.maxConsecutiveErrors) {
		return { intent: "abort", reason: "maximum consecutive errors reached" };
	}

	for (const metric of state.qualityMetrics ?? []) {
		const minRatio = metric.minRatio ?? 0.8;
		const threshold = metric.baseline * minRatio;
		if (metric.value < threshold) {
			return {
				intent: "request_operator",
				reason: `${metric.name} below watchdog quality threshold`,
			};
		}
	}

	if (state.artifactGuard && state.artifactGuard.actual < state.artifactGuard.expectedAtLeast) {
		return { intent: "request_operator", reason: "required artifact references are missing" };
	}

	if (state.budgetGuard) {
		const pauseAtRatio = state.budgetGuard.pauseAtRatio ?? 1;
		if (state.budgetGuard.maxUnits > 0 && state.budgetGuard.completedUnits / state.budgetGuard.maxUnits >= pauseAtRatio) {
			return { intent: "pause", reason: "unit budget guard reached" };
		}
	}

	return { intent: "none" };
}
