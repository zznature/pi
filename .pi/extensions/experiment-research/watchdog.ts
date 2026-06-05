import { existsSync, readFileSync } from "node:fs";

export type WatchdogIntent = "none" | "pause" | "abort" | "request_operator";

export interface WatchdogState {
	nowMs: number;
	lastHeartbeatMs: number;
	heartbeatTimeoutMs: number;
	consecutiveErrors: number;
	maxConsecutiveErrors: number;
	intentsPath?: string;
}

export interface WatchdogDecision {
	intent: WatchdogIntent;
	reason?: string;
}

function readLatestOperatorIntent(path: string | undefined): WatchdogDecision | undefined {
	if (!path || !existsSync(path)) return undefined;
	const lines = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	for (const line of lines.reverse()) {
		const parsed = JSON.parse(line) as { type?: unknown; intent?: unknown; reason?: unknown };
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

	return { intent: "none" };
}
