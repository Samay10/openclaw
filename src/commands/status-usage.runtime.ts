// Optional status usage probes own credential and provider runtime imports.
import {
  resolveAmbientOwnerAgentId,
  resolveConfiguredAgentId,
} from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-routing.js";
import { resolveCommandConfigWithSecrets } from "../cli/command-config-resolution.js";
import { getModelsCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  buildCodexSyntheticUsageAuth,
  mergeUsageSummaries,
  shouldUseCodexSyntheticUsageForRuntime,
  resolveUsageCredentialType,
} from "../status/codex-synthetic-usage.js";
import { resolveStatusGatewayProbeTimeoutMs } from "./status.gateway-probe-budget.js";

const providerUsageLoader = createLazyImportLoader(() => import("../infra/provider-usage.js"));

function shouldUseConfiguredCodexSyntheticUsage(params: {
  config: OpenClawConfig;
  agentDir: string;
  agentId?: string;
}): boolean {
  const configuredDefault = resolveDefaultModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
    allowPluginNormalization: false,
  });
  const policy = resolveAgentHarnessPolicy({
    config: params.config,
    agentId: params.agentId,
    provider: configuredDefault.provider,
    modelId: configuredDefault.model,
  });
  if (
    !shouldUseCodexSyntheticUsageForRuntime({
      provider: configuredDefault.provider,
      effectiveHarness: policy.runtime,
    })
  ) {
    return false;
  }
  const authLabel = resolveModelAuthLabel({
    provider: configuredDefault.provider,
    acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: configuredDefault.provider,
      harnessRuntime: policy.runtime,
      config: params.config,
    }),
    cfg: params.config,
    agentDir: params.agentDir,
    includeExternalProfiles: false,
  });
  return resolveUsageCredentialType(authLabel) !== "api_key";
}

/** Materialize model-provider SecretRefs so usage auth matches runtime credentials. */
async function resolveUsageConfigWithProviderSecrets(params: {
  config: OpenClawConfig;
  agentId?: string;
  timeoutMs?: number;
}): Promise<OpenClawConfig> {
  const { resolvedConfig } = await resolveCommandConfigWithSecrets({
    config: params.config,
    commandName: "status --usage",
    targetIds: getModelsCommandSecretTargetIds(),
    mode: "read_only_status",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.timeoutMs !== undefined ? { gatewaySecretResolveTimeoutMs: params.timeoutMs } : {}),
  });
  return resolvedConfig;
}

export type StatusUsageSummaryOptions = {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  agentId?: string;
  agentDir?: string;
};

/** Loads provider usage for status output from an explicit or ambient system-agent scope. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await providerUsageLoader.load();
  const rawAgentId = params.agentId?.trim();
  if (params.agentId !== undefined && !rawAgentId) {
    throw new Error("--agent must not be blank");
  }
  const agentId = rawAgentId ? normalizeAgentId(rawAgentId) : undefined;
  if (agentId) {
    resolveConfiguredAgentId(params.config, agentId);
  }
  let resolvedAgentId = agentId;
  let agentDir = params.agentDir;
  if (!agentDir) {
    resolvedAgentId ??= resolveAmbientOwnerAgentId(params.config, undefined, {
      surface: "status usage credentials",
      hint: "Set agents.defaults.systemAgent.agentId.",
    });
    agentDir = resolveAgentDir(params.config, resolvedAgentId);
  }
  // Status scans omit model-provider targets. Prepare them here so exec and
  // store SecretRefs reach usage auth as the same credentials inference uses.
  const config = await resolveUsageConfigWithProviderSecrets({
    config: params.config,
    timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
  });
  const usage = await loadProviderUsageSummary({
    timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
    config,
    agentDir,
  });
  if (
    !shouldUseConfiguredCodexSyntheticUsage({
      config,
      agentDir,
      agentId: resolvedAgentId,
    })
  ) {
    return usage;
  }
  const codexUsage = await loadProviderUsageSummary({
    timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
    providers: ["openai"],
    auth: [buildCodexSyntheticUsageAuth()],
    config,
    agentDir,
  });
  return mergeUsageSummaries(usage, codexUsage);
}
