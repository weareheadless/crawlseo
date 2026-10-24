export type AgentTimeouts = {
  inactivityMs: number;
  maxRuntimeMs: number;
};

function minutes(value: string | undefined, fallbackMinutes: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMinutes;
  return Math.max(1, Math.min(parsed, 360));
}

export function agentTimeouts(input: {
  batch: boolean;
  env?: Record<string, string | undefined>;
}): AgentTimeouts {
  const env = input.env ?? process.env;
  return {
    inactivityMs: minutes(
      env.AGENT_INACTIVITY_TIMEOUT_MINUTES,
      input.batch ? 20 : 15,
    ) * 60_000,
    maxRuntimeMs: minutes(
      env.AGENT_MAX_RUNTIME_MINUTES,
      input.batch ? 120 : 60,
    ) * 60_000,
  };
}
