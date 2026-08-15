/**
 * Real model/provider discovery for the TUI (no fake data).
 *
 * The model picker only ever lists models that are actually reachable:
 *   - local Groq key        → the LIVE Groq catalog (provider.listModels),
 *                             falling back to the documented Groq table.
 *   - GRACE backend (login) → the documented NVIDIA/Groq/DeepSeek catalog the
 *                             server-side router serves, plus the shipped
 *                             defaults. The server verifies any model id.
 * The provider picker only lists providers that are genuinely configured.
 */
import { groqApiKey, loadAppConfig, saveAppConfig, DEFAULT_MODELS } from '../../config/config.ts';
import { loadSession, sessionExpired } from '../../auth/session.ts';
import { pickModelForProvider, allKnownModels } from '../../agents/modelRouter.ts';
import { createProvider } from '../../providers/registry.ts';
import { RemoteProvider } from '../../providers/remote.ts';
import type { AIProvider } from '../../providers/types.ts';
import type { Runtime } from '../../runtime.ts';
import type { PickerOption } from './types.ts';

/** The provider id that actually serves requests (after router fallback). */
export function servingProviderId(runtime: Runtime): string | null {
  if (runtime.provider?.id !== 'remote') return runtime.provider?.id ?? null;
  const served = runtime.provider instanceof RemoteProvider ? (runtime.provider.serverProvider ?? RemoteProvider.sharedServerProvider()) : null;
  return served?.id ?? null;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The real set of models for the active provider. Never invents models.
 * Returns [] when nothing is configured.
 */
export async function discoverModels(runtime: Runtime): Promise<PickerOption[]> {
  const provider = runtime.provider;
  if (!provider) return [];

  const current = provider.getModel().id;
  const servedId = servingProviderId(runtime);
  const servedLabel = provider instanceof RemoteProvider ? (provider.serverProvider?.label ?? RemoteProvider.sharedServerProvider()?.label) : null;

  let ids: string[];
  if (provider.id === 'groq') {
    // Live catalog first (real), documented table as an offline fallback.
    const live = await provider.listModels();
    ids = live.length > 0 ? live : allKnownModels('groq');
  } else {
    // Remote/backend: the server-side router serves NVIDIA + Groq (+ DeepSeek
    // wiring). These are the real documented ids the backend can route.
    ids = [...DEFAULT_MODELS, ...allKnownModels('nvidia'), ...allKnownModels('groq'), ...allKnownModels('deepseek')];
  }

  return dedupe(ids).map((id) => ({
    value: id,
    label: id,
    hint: servedLabel ? `via ${servedLabel}` : hintForModel(provider, id),
    current: id === current,
  }));
}

/** Short human hint for a model on a local provider. */
function hintForModel(provider: AIProvider, id: string): string | undefined {
  if (provider.id !== 'groq') return undefined;
  if (id.includes('gpt-oss-120b')) return 'fast coding · recommended';
  if (id.includes('gpt-oss-20b')) return 'light & fast';
  if (id.includes('qwen')) return 'coding';
  if (id.includes('llama')) return 'general';
  return undefined;
}

/** Providers that are actually configured (real keys/sessions only). */
export function discoverProviders(runtime: Runtime): PickerOption[] {
  const opts: PickerOption[] = [];
  const key = groqApiKey();
  const stored = loadSession();
  const loggedIn = stored !== null && !sessionExpired(stored);

  if (key) {
    opts.push({
      value: 'groq',
      label: 'Groq (LPU)',
      hint: 'local API key · offline/self-hosted',
      current: runtime.provider?.id === 'groq',
    });
  }
  if (loggedIn) {
    opts.push({
      value: 'backend',
      label: 'GRACE backend',
      hint: 'Groq → NVIDIA → Gemini → MiniMax · server-side keys',
      current: runtime.provider?.id === 'remote',
    });
  }
  return opts;
}

/** Apply a picker selection to the real runtime + persisted config. */
export function applyProviderSelection(runtime: Runtime, value: string): string | null {
  if (value === 'groq') {
    const key = groqApiKey();
    if (!key) return 'No GROQ_API_KEY configured — add it to ~/.zeesh/env or the project .env first.';
    const model = pickModelForProvider('groq', 'coding', runtime.model);
    runtime.provider = createProvider('groq', { apiKey: key, model });
    runtime.providerError = null;
    runtime.model = model;
    saveAppConfig({ ...loadAppConfig(), provider: 'groq', model });
    return null;
  }
  if (value === 'backend') {
    const stored = loadSession();
    if (!stored || sessionExpired(stored)) return 'Not logged in — run /login first to use the GRACE backend.';
    runtime.provider = new RemoteProvider({ apiUrl: stored.apiUrl, token: stored.token, model: runtime.model });
    runtime.providerError = null;
    saveAppConfig({ ...loadAppConfig(), provider: 'remote', model: runtime.model });
    return null;
  }
  return `Unknown provider "${value}".`;
}

/** Persist a model selection on the active provider. Returns error text or null. */
export function applyModelSelection(runtime: Runtime, modelId: string): string | null {
  const provider = runtime.provider;
  if (!provider) return 'No AI provider configured.';
  try {
    provider.setModel(modelId);
  } catch (err) {
    return (err as Error).message;
  }
  runtime.model = modelId;
  saveAppConfig({ ...loadAppConfig(), provider: runtime.provider?.id, model: modelId });
  return null;
}
