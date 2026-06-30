import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_PYTHON_RELATIVE_PATHS = [
	[".venv", "python.exe"],
	[".venv", "Scripts", "python.exe"],
	[".venv", "bin", "python"],
] as const;

export interface PythonResolution {
	pythonPath: string;
	candidates: string[];
}

export function resolveProjectPython(cwd: string, override?: string): PythonResolution {
	if (override) {
		return {
			pythonPath: override,
			candidates: [override],
		};
	}
	const candidates = PROJECT_PYTHON_RELATIVE_PATHS.map((segments) => resolve(cwd, ...segments));
	const pythonPath = candidates.find((candidate) => existsSync(candidate));
	if (!pythonPath) {
		throw new Error(`project Python not found in .venv (${candidates.join(", ")})`);
	}
	return { pythonPath, candidates };
}
