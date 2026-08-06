import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readData } from '../store.js';
import type { AgentEvent, ArtifactKind, PlanTask } from '../types.js';
import {
  docPolicyFor,
  formatMemoryForPrompt,
  loadAgentMemory,
  memoryMaintenanceDirective,
  writeProjectFact,
} from './agent-memory.js';
import { extractMemorySection } from './memory-extract.js';
import { agentForTask, type AgentProfile } from './agent-roster.js';
import { deliverableText } from './deliverable.js';
import { runOnE2B } from './adapters/e2b-adapter.js';
import { MiniMaxRequestError, MiniMaxUnavailableError, resolvedMiniMaxModel, runOnMiniMax } from './adapters/minimax-adapter.js';
import { OpenAICompatRequestError, OpenAICompatUnavailableError, resolvedOpenAICompatModel, runOnOpenAICompat } from './adapters/openai-compat-adapter.js';
import { configuredRuntimeForAgent, mergedRuntimeConfigForAgent } from './cli-runtimes/registry.js';
import { executeCliRuntime } from './cli-runtimes/runner.js';
import {
  clearCliSession,
  cliSessionFor,
  runtimeSupportsResume,
  saveCliSession,
} from './cli-runtimes/sessions.js';
import {
  createRuntimeConversation,
  finishRuntimeConversation,
  runtimeConversationCallbacks,
} from './runtime-actions.js';
import { applyDocPolicy, quarantineDocs } from './turns/doc-policy.js';
import { collectChangedWorkspaceFiles, type ChangedWorkspaceFile } from './turns/workspace-scan.js';

export type AgentRunResult = {
  text: string;
  path: string;
  kind: ArtifactKind;
  events: AgentEvent[];
  ok: boolean;
  error: string | null;
  // Real files the agent produced or edited in the workspace during this run
  // (CLI-backed agents only). These are the deliverables; `text` is the
  // agent's narration and must never be presented as the product.
  files?: ChangedWorkspaceFile[] | undefined;
};

export async function runAgentTask(input: {
  adapter: string;
  workspace: string;
  task: PlanTask;
  message: string;
  turnId?: string | undefined;
  // Chat the turn belongs to: the scope for CLI session reuse, so consecutive
  // turns in one chat resume the same CLI conversation.
  chatId?: string | null | undefined;
  handoffContext?: string | undefined;
  runtimeEnv?: NodeJS.ProcessEnv | undefined;
}): Promise<AgentRunResult> {
  const adapter = normalizeAdapter(input.adapter);
  if (adapter === 'minimax') {
    return runMiniMaxTask(input);
  }
  if (adapter === 'openai-compat') {
    return runOpenAICompatTask(input);
  }
  if (adapter === 'e2b') {
    return runE2BTask(input);
  }
  if (adapter === 'agent-cli') {
    return runAgentCliTask(input);
  }
  return runLocalTask(input);
}

export function normalizeAdapter(
  value: string | null | undefined,
): 'local-dispatch' | 'agent-cli' | 'e2b' | 'minimax' | 'openai-compat' {
  const raw = (value || process.env.ROUNDTABLE_AGENT_ADAPTER || 'local-dispatch').trim().toLowerCase();
  if (raw === 'minimax') return 'minimax';
  // Generic OpenAI-compatible adapter (DeepSeek, Together, Groq, local vLLM, …).
  // Accept a few friendly aliases for the same code path.
  if (raw === 'openai-compat' || raw === 'openai' || raw === 'deepseek') return 'openai-compat';
  if (raw === 'e2b') return 'e2b';
  if (raw === 'agent-cli' || raw === 'external-cli' || raw === 'cli-runtime' || raw === 'runtime' || raw === 'cli') {
    return 'agent-cli';
  }
  const wantsExternalCli = raw === 'claude'
    || raw === 'claude-code'
    || raw === 'claude-cli'
    || raw === 'codex'
    || raw === 'codex-cli'
    || raw === 'opencode';
  if (wantsExternalCli && externalCliEnabled()) return 'agent-cli';
  return 'local-dispatch';
}

function externalCliEnabled(): boolean {
  return process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT === '1'
    || process.env.ROUNDTABLE_ALLOW_CLAUDE_CLI === '1';
}

async function runLocalTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const role = agent.role;
  const path = pathForTask(input.task);
  const text = localArtifactText(input.task, input.message, path, input.handoffContext);
  await writeWorkspaceFile(input.workspace, path, text);
  const toolId = `tool_${input.task.id}`;
  return {
    text,
    path,
    kind: kindForPath(path),
    ok: true,
    error: null,
    events: [
      { type: 'thinking_delta', delta: `${role} received the handoff and prepared ${path}.` },
      { type: 'tool_use', id: toolId, name: 'write_artifact', input: { path, role, agentId: agent.id } },
      { type: 'tool_result', id: toolId, output: { path, bytes: text.length } },
      { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
      { type: 'text_delta', delta: `Created ${path}.` },
      { type: 'done', finishReason: 'completed' },
    ],
  };
}

async function runAgentCliTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  turnId?: string | undefined;
  chatId?: string | null | undefined;
  handoffContext?: string | undefined;
  runtimeEnv?: NodeJS.ProcessEnv | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  // A CLI-backed agent edits real files in the workspace; its stdout is a
  // transcript, not the deliverable. The transcript is therefore stored as a
  // Markdown log — NEVER as .html — and the actual deliverables are collected
  // from the workspace after the run.
  const path = transcriptPathForTask(input.task);
  const memory = await loadAgentMemory({ workspace: input.workspace, agentId: agent.id });
  const prompt = agentPrompt(agent, input, {
    memoryBlock: formatMemoryForPrompt(memory, `${input.task.title} ${input.task.brief} ${input.message}`),
    maintenanceBlock: memoryMaintenanceDirective(memory),
  });
  const data = await readData();
  const runtimeEnv = input.runtimeEnv ?? process.env;
  const runtime = configuredRuntimeForAgent(agent, data.agentRuntimeConfigs, runtimeEnv);
  if (runtime === 'local-dispatch') return runLocalTask(input);

  const config = mergedRuntimeConfigForAgent(
    agent,
    runtime,
    data.agentRuntimeConfigs,
    data.agentRuntimeDefaults,
  );
  const conversation = await createRuntimeConversation({
    agent,
    runtime,
    title: input.task.title,
    workspacePath: input.workspace,
    turnId: input.turnId ?? null,
    taskId: input.task.id,
  });
  const toolId = `tool_${input.task.id}`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `Starting ${agent.displayName} through ${runtime}.` },
    {
      type: 'tool_use',
      id: toolId,
      name: 'agent_runtime',
      input: { runtime, agentId: agent.id, role: agent.role, path, conversationId: conversation.id },
    },
  ];

  try {
    // Small backdate so a file the CLI writes in the same tick as the spawn is
    // never missed by the post-run mtime scan.
    const startedMs = Date.now() - 2_000;
    // Session continuity: resume the chat's stored CLI session for this agent
    // so the model keeps its conversation memory across turns. Scope state
    // (router HOME/port) by chat, falling back to turn for chat-less runs.
    const sessionScope = input.chatId ?? input.turnId ?? input.task.id;
    const storedSession = runtimeSupportsResume(runtime)
      ? await cliSessionFor(input.workspace, runtime, agent.id)
      : null;
    const runOnce = (resumeSessionId: string | undefined) => executeCliRuntime({
      conversationId: conversation.id,
      runtime,
      agent,
      config,
      workspace: input.workspace,
      prompt,
      timeoutMs: timeoutMs(),
      idleTimeoutMs: idleTimeoutMs(),
      envSnapshot: runtimeEnv,
      callbacks: runtimeConversationCallbacks(conversation.id),
      resumeSessionId,
      sessionScopeId: sessionScope,
    });
    let result = await runOnce(storedSession ?? undefined);
    let staleSessionNote: AgentEvent | null = null;
    // A stored session can expire or vanish (CLI state cleaned, HOME moved). A
    // failed resume must not brick the chat: drop it and retry cold once.
    if (!result.ok && storedSession) {
      await clearCliSession(input.workspace, runtime, agent.id);
      staleSessionNote = {
        type: 'thinking_delta',
        delta: `Resuming CLI session ${storedSession} failed; retried with a fresh session.`,
      };
      result = await runOnce(undefined);
    }
    const ok = result.ok;
    if (ok && result.sessionId) {
      await saveCliSession(input.workspace, runtime, agent.id, result.sessionId);
    }
    const text = ok
      ? result.text
      : `# ${input.task.title}\n\n${runtime} did not produce a usable result.\n\n${result.text}`;
    await writeWorkspaceFile(input.workspace, path, transcriptMarkdown(input.task, agent.displayName, runtime, text));
    const scan = ok
      ? await collectChangedWorkspaceFiles(input.workspace, startedMs)
      : { files: [], skipped: [] };
    await finishRuntimeConversation(conversation.id, ok ? 'completed' : 'failed', result.error, result.sessionId);
    // Document policy gate: stray Markdown never becomes an artifact. It is
    // moved to quarantine and folded into unreviewed memory instead.
    const policy = applyDocPolicy({ task: input.task, agent, files: scan.files });
    const quarantine = policy.quarantined.length > 0
      ? await quarantineDocs({
          workspace: input.workspace,
          taskId: input.task.id,
          agentId: agent.id,
          quarantined: policy.quarantined,
        })
      : { moved: [], folded: [], failed: [] };
    return {
      text,
      path,
      kind: 'markdown',
      ok,
      error: result.error,
      files: policy.kept,
      events: [
        ...started,
        ...(staleSessionNote ? [staleSessionNote] : []),
        ...(quarantine.moved.length > 0
          ? [{
              type: 'text_delta',
              delta: `Document policy: quarantined ${quarantine.moved.length} stray Markdown file(s) — ${quarantine.moved.slice(0, 5).join(', ')}${quarantine.moved.length > 5 ? ', …' : ''} → .roundtable/quarantine/${input.task.id}/ (${quarantine.folded.length} folded into unreviewed memory).`,
            } as AgentEvent]
          : []),
        ...(quarantine.failed.length > 0
          ? [{
              type: 'thinking_delta',
              delta: `Document policy: failed to quarantine ${quarantine.failed.join(', ')} — check workspace filesystem permissions.`,
            } as AgentEvent]
          : []),
        {
          type: 'tool_result',
          id: toolId,
          output: {
            runtime,
            command: result.command,
            pid: result.pid ?? 0,
            chars: result.text.length,
            conversationId: conversation.id,
          },
          ...(ok ? {} : { isError: true }),
        },
        ...result.events,
        ...policy.kept.map((file): AgentEvent => (
          { type: 'file_change', path: file.path, kind: 'edit', diff: `produced ${file.path}` }
        )),
        ...(scan.skipped.length > 0
          ? [{
              type: 'text_delta',
              delta: `${scan.skipped.length} changed file(s) not captured as artifacts (binary, oversized, or over the cap): ${scan.skipped.slice(0, 5).join(', ')}${scan.skipped.length > 5 ? ', …' : ''}`,
            } as AgentEvent]
          : []),
        {
          type: 'text_delta',
          delta: ok
            ? `${agent.displayName} completed via ${runtime}; ${policy.kept.length} deliverable file(s) captured, transcript at ${path}.`
            : `${runtime} failed; captured diagnostic log at ${path}.`,
        },
        ok ? { type: 'done', finishReason: 'completed' } : { type: 'error', message: result.error ?? 'runtime_failed', recoverable: true },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = `# ${input.task.title}\n\nAgent CLI failed before producing output.\n\n${message}`;
    await writeWorkspaceFile(input.workspace, path, text);
    await finishRuntimeConversation(conversation.id, 'failed', message);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: false,
      error: message,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { error: message }, isError: true },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        { type: 'error', message, recoverable: true },
      ],
    };
  }
}

// Runs the agent prompt inside an E2B sandbox. Throws E2BUnavailableError (from
// runOnE2B) when no key is configured — the dispatch layer catches it and falls
// back to local-dispatch, so this never silently degrades here.
async function runE2BTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const prompt = agentPrompt(agent, input);
  const command = commandForAgent(agent);
  const args = commandArgs(prompt, agent);
  const toolId = `tool_${input.task.id}`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `Starting ${agent.displayName} in E2B sandbox.` },
    { type: 'tool_use', id: toolId, name: 'e2b_run', input: { command, agentId: agent.id, role: agent.role, path } },
  ];
  const run = await runOnE2B({ command, args, env: e2bAgentEnv(), timeoutMs: timeoutMs() });
  const ok = run.exitCode === 0 && run.summary.length > 0;
  const text = ok
    ? run.summary
    : `# ${input.task.title}\n\nE2B run did not produce a usable result.\n\n${run.code || run.summary}`;
  await writeWorkspaceFile(input.workspace, path, text);
  return {
    text,
    path,
    kind: kindForPath(path),
    ok,
    error: ok ? null : `e2b_exit_${run.exitCode}`,
    events: [
      ...started,
      { type: 'tool_result', id: toolId, output: { exitCode: run.exitCode }, ...(ok ? {} : { isError: true }) },
      { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
      { type: 'text_delta', delta: ok ? `${agent.displayName} completed in E2B; transcript at ${path}.` : `E2B run failed; diagnostic saved at ${path}.` },
      ok ? { type: 'done', finishReason: 'completed' } : { type: 'error', message: `e2b_exit_${run.exitCode}`, recoverable: true },
    ],
  };
}

function e2bAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(ANTHROPIC|OPENAI|ROUNDTABLE)_/.test(key)) env[key] = value;
  }
  return env;
}

// Shared implementation for chat-only model adapters (MiniMax, OpenAI-compat):
// same prompts, same deliverable extraction, same failure semantics. Only the
// transport call and display metadata differ per provider.
type ChatModelRun = (input: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  timeoutMs?: number | undefined;
  maxTokens?: number | undefined;
}) => Promise<{ text: string; usage?: Record<string, unknown> | undefined; finishReason?: string | undefined }>;

async function runChatModelTask(
  input: {
    workspace: string;
    task: PlanTask;
    message: string;
    handoffContext?: string | undefined;
  },
  provider: { name: string; toolName: string; model: string; run: ChatModelRun; isUnavailable: (error: unknown) => boolean },
): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const toolId = `tool_${input.task.id}`;
  const system = chatAgentPrompt(agent, input);
  // Chat agents can't write files, so memory is read-only recall for them: it
  // still lets the agent answer with what it learned in earlier missions.
  const memory = await loadAgentMemory({ workspace: input.workspace, agentId: agent.id });
  const memoryBlock = formatMemoryForPrompt(memory, `${input.task.title} ${input.task.brief} ${input.message}`);
  const user = [
    `Task: ${input.task.title}`,
    ...(memoryBlock ? ['', memoryBlock] : []),
    ...(input.handoffContext ? ['', 'Context from earlier agents:', '', input.handoffContext] : []),
    '',
    'Create the next useful output for your role.',
  ].join('\n');
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `${agent.displayName} querying ${provider.model}.` },
    { type: 'tool_use', id: toolId, name: provider.toolName, input: { agentId: agent.id, role: agent.role, path } },
  ];

  const failure = async (message: string, rawResponse?: string): Promise<AgentRunResult> => {
    const text = [
      `# ${input.task.title}`,
      '',
      `${provider.name} did not produce a usable deliverable for ${path}.`,
      '',
      `Error: ${message}`,
      ...(rawResponse ? ['', '---', '', rawResponse.slice(0, 2000)] : []),
    ].join('\n');
    await writeWorkspaceFile(input.workspace, path, text);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: false,
      error: message,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { error: message }, isError: true },
        { type: 'error', message, recoverable: true },
      ],
    };
  };

  try {
    // Deliverables (full HTML pages especially) routinely exceed one response's
    // token ceiling and come back cut mid-tag — the model writes <head> CSS
    // first, so a single truncated response renders as a BLANK page. When the
    // provider reports finish_reason=length, ask it to continue from the exact
    // cut point and stitch the halves, bounded by maxModelContinuations().
    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let combined = '';
    let run: Awaited<ReturnType<ChatModelRun>>;
    let rounds = 0;
    do {
      run = await provider.run({
        messages,
        timeoutMs: timeoutMs(),
        maxTokens: modelMaxTokens(),
      });
      combined += run.text;
      if (run.finishReason !== 'length') break;
      messages = [
        ...messages,
        { role: 'assistant', content: run.text },
        {
          role: 'user',
          content: 'Your previous output was cut off mid-way. Continue EXACTLY from where it stopped. '
            + 'Do not repeat anything you already wrote, do not add any preamble or code fences — '
            + 'output only the remaining content.',
        },
      ];
      rounds += 1;
    } while (rounds <= maxModelContinuations());
    // The optional trailing `## Memory` section is the chat agent's only write
    // path into its memory store — capture it and strip it from the deliverable.
    const extraction = extractMemorySection(combined);
    // Extraction is strict on purpose: a .html artifact holding prose, a raw
    // fence, or a page cut before <body> is worse than a failed task, because a
    // failure feeds the review→fix loop while a garbage artifact ships as
    // "completed".
    const text = deliverableText(extraction.text, path);
    if (text === null || text.length === 0) {
      return failure('deliverable_not_usable', combined);
    }
    await writeWorkspaceFile(input.workspace, path, text);
    const captured: string[] = [];
    for (const fact of extraction.facts) {
      const wrote = await writeProjectFact({
        workspace: input.workspace,
        agentId: agent.id,
        slug: fact.slug,
        description: fact.description,
        type: 'note',
        source: `chat:${input.task.id}`,
        body: fact.body,
      }).catch(() => false);
      if (wrote) captured.push(fact.slug);
    }
    const reasoningTokens = (run.usage?.['completion_tokens_details'] as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: true,
      error: null,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { model: provider.model, reasoningTokens: reasoningTokens ?? 0, chars: text.length } },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        ...(captured.length > 0
          ? [{
              type: 'thinking_delta',
              delta: `Memory: captured ${captured.length} fact(s) from the reply — ${captured.join(', ')}.`,
            } as AgentEvent]
          : []),
        { type: 'text_delta', delta: `${agent.displayName} produced ${path} via ${provider.model}.` },
        { type: 'done', finishReason: 'completed' },
      ],
    };
  } catch (error) {
    if (provider.isUnavailable(error)) throw error; // let dispatch fall back
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// Runs the task against the real MiniMax model. Throws MiniMaxUnavailableError
// (from runOnMiniMax) when no key is set — the dispatch layer catches it and
// falls back to local-dispatch.
async function runMiniMaxTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const model = await resolvedMiniMaxModel();
  return runChatModelTask(input, {
    name: 'MiniMax',
    toolName: 'minimax_chat',
    model,
    run: runOnMiniMax,
    isUnavailable: (error) => error instanceof MiniMaxUnavailableError || error instanceof MiniMaxRequestError,
  });
}

// Runs the task against the configured OpenAI-compatible model. Throws
// OpenAICompatUnavailableError (from runOnOpenAICompat) when unconfigured — the
// dispatch layer catches it and falls back to local-dispatch.
async function runOpenAICompatTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const model = await resolvedOpenAICompatModel();
  return runChatModelTask(input, {
    name: model,
    toolName: 'model_chat',
    model,
    run: runOnOpenAICompat,
    isUnavailable: (error) => error instanceof OpenAICompatUnavailableError || error instanceof OpenAICompatRequestError,
  });
}

function pathForTask(task: PlanTask): string {
  // A fixer repairing a concrete deliverable writes the corrected output to the
  // SAME path as the original, so the fix replaces the flawed page instead of
  // landing in a markdown file nobody previews.
  if (task.repairTargetPath) return task.repairTargetPath;
  const slug = taskSlug(task);
  const agent = agentForTask(task);
  // Answering a question produces notes, never a page — regardless of whether
  // the question mentions a website.
  if (task.stageId === 'answer') return `.roundtable/runs/docs/${slug}.md`;
  // A web/page build should produce a previewable HTML artifact, not a Markdown
  // doc — otherwise the model is never asked for a real page and the UI can't
  // render a preview. Detect intent from the task's text (title + brief).
  // Applies to chat-only model adapters, whose response text IS the deliverable;
  // CLI-backed agents write real files instead (see transcriptPathForTask).
  if (agent.role === 'implementer') {
    const taskText = `${task.title} ${task.objective ?? ''} ${task.brief} ${(task.acceptanceCriteria ?? []).join(' ')}`;
    const ext = wantsPythonCode(taskText) ? 'py' : wantsWebPage(taskText) ? 'html' : 'md';
    return `.roundtable/runs/work/${slug}.${ext}`;
  }
  if (agent.role === 'reviewer') return `.roundtable/runs/review/${slug}.md`;
  if (agent.role === 'fixer') return `.roundtable/runs/fixes/${slug}.md`;
  return `.roundtable/runs/docs/${slug}.md`;
}

// Where a CLI-backed agent's run transcript is stored. Always Markdown: the
// transcript is narration about the work, and storing it as .html is what used
// to make the UI "preview" a wall of prose instead of the built page.
export function transcriptPathForTask(task: PlanTask): string {
  return `.roundtable/runs/logs/${taskSlug(task)}.md`;
}

function taskSlug(task: PlanTask): string {
  return task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || task.id;
}

function transcriptMarkdown(task: PlanTask, agentName: string, runtime: string, text: string): string {
  return [
    `# Run log · ${task.title}`,
    '',
    `Agent: ${agentName} · Runtime: ${runtime}`,
    '',
    text,
  ].join('\n');
}

// Does this build target a renderable web page? Covers EN + 中文 vocabulary.
function wantsWebPage(text: string): boolean {
  if (wantsCodeArtifact(text)) return false;
  return /\b(website|web\s?page|webpage|landing|page|site|html|frontend|ui|dashboard|portfolio|checkout|payment|cart)\b|网站|网页|页面|前端|官网|落地页|主页|仪表盘|看板|结账|支付|购物车/i.test(text);
}

function wantsPythonCode(text: string): boolean {
  return /\bpython\b|\.py\b|py脚本|python脚本|python代码/i.test(text);
}

function wantsCodeArtifact(text: string): boolean {
  return wantsPythonCode(text)
    || /\b(script|code|cli|library|package|module|function|notebook|jupyter|api)\b|代码|脚本|函数|模块|库|命令行|接口|笔记本/i.test(text);
}

function kindForPath(path: string): ArtifactKind {
  if (path.endsWith('.html')) return 'preview';
  if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js') || path.endsWith('.py')) return 'code';
  return 'markdown';
}

async function writeWorkspaceFile(workspace: string, relativePath: string, text: string): Promise<void> {
  const target = join(workspace, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

function localArtifactText(task: PlanTask, message: string, path: string, handoffContext?: string): string {
  if (path.endsWith('.html')) return localHtmlArtifact(message);
  if (path.endsWith('.py')) return localPythonArtifact(message);
  const focus = userGoalTitle(message);
  const agent = agentForTask(task);
  const role = agent.role;
  return [
    `# ${task.title}`,
    '',
    `Role: ${task.assignee}`,
    `Agent: ${agent.displayName}`,
    '',
    `User goal: ${message}`,
    '',
    ...(handoffContext ? ['## Previous agent output', '', handoffContext, ''] : []),
    '## What this task will produce',
    '',
    role === 'architect'
      ? `- Structure the work around "${focus}".\n- Keep the frontend contract stable.\n- Hand off clear implementation and review checkpoints.`
      : role === 'reviewer'
        ? `- Check that the output directly answers "${focus}".\n- Review accessibility, copy clarity, and visible completeness.\n- Call out missing production integrations.`
        : `- Produce a concrete deliverable for "${focus}".\n- Keep the artifact easy to preview from Roundtable.`,
    '',
    '## Notes',
    '',
    'This artifact was produced through the Roundtable backend action layer and can be replayed by devrt.',
  ].join('\n');
}

function localPythonArtifact(message: string): string {
  const title = userGoalTitle(message);
  return [
    '"""',
    `${title}`,
    '',
    'Deterministic Roundtable fallback implementation.',
    'Replace the placeholder algorithm with the paper-specific RMU details after review.',
    '"""',
    '',
    'from __future__ import annotations',
    '',
    'from dataclasses import dataclass',
    'from typing import Iterable',
    '',
    '',
    '@dataclass(frozen=True)',
    'class RMUConfig:',
    '    layer: int',
    '    coefficient: float = 1.0',
    '    retain_weight: float = 1.0',
    '',
    '',
    'def normalize_vector(values: Iterable[float]) -> list[float]:',
    '    vector = [float(value) for value in values]',
    '    norm = sum(value * value for value in vector) ** 0.5',
    '    if norm == 0:',
    '        return [0.0 for _ in vector]',
    '    return [value / norm for value in vector]',
    '',
    '',
    'def rmu_direction(forget_activations: Iterable[float], retain_activations: Iterable[float], config: RMUConfig) -> list[float]:',
    '    forget = normalize_vector(forget_activations)',
    '    retain = normalize_vector(retain_activations)',
    '    width = min(len(forget), len(retain))',
    '    return [config.coefficient * forget[i] - config.retain_weight * retain[i] for i in range(width)]',
    '',
    '',
    'if __name__ == "__main__":',
    '    cfg = RMUConfig(layer=12, coefficient=1.2, retain_weight=0.8)',
    '    direction = rmu_direction([1.0, 0.5, 0.1], [0.2, 0.4, 0.9], cfg)',
    '    print({"layer": cfg.layer, "direction": direction})',
    '',
  ].join('\n');
}

function localHtmlArtifact(message: string): string {
  const title = userGoalTitle(message);
  if (/\b(checkout|payment|cart|post-?payment|stripe)\b|结账|支付|购物车|订单确认/i.test(message)) {
    return checkoutFlowHtml(title);
  }
  const isPersonalSite = /个人网站|portfolio|personal\s+site|resume|简历|主页/i.test(message);
  const headline = isPersonalSite ? '个人网站' : title;
  const subhead = isPersonalSite
    ? '一个用于展示个人介绍、项目作品和联系方式的响应式页面。'
    : `根据任务「${title}」生成的可预览页面。`;
  const sections: Array<[string, string]> = isPersonalSite
    ? [
        ['关于我', '用一段清晰的简介说明身份、方向和当前关注的项目。'],
        ['精选项目', '展示 3 个代表性项目，包含背景、贡献和结果。'],
        ['技能栈', '列出前端、后端、AI 工具链和协作能力。'],
        ['联系我', '提供邮箱、社交链接和一个简短行动按钮。'],
      ]
    : [
        ['目标', `完成用户请求：${message}`],
        ['交付物', '提供一个可直接预览、可继续迭代的页面雏形。'],
        ['下一步', '接入真实数据、补充品牌样式，并进行可访问性检查。'],
      ];
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light;--ink:#181622;--muted:#6f6a85;--line:#ded8ef;--accent:#7d6bd6;--bg:#f6f2ff}',
    '*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#fff,var(--bg));color:var(--ink)}',
    'main{max-width:980px;margin:0 auto;padding:56px 24px 72px}header{display:grid;gap:16px;margin-bottom:34px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:800}',
    'h1{font-size:clamp(40px,7vw,76px);line-height:.95;margin:0;letter-spacing:-.04em}p{font-size:18px;line-height:1.7;color:var(--muted);max-width:720px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:28px}',
    '.card{background:rgba(255,255,255,.82);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 18px 50px -32px rgba(50,38,100,.45)}h2{font-size:18px;margin:0 0 10px}.cta{display:inline-flex;margin-top:18px;padding:12px 18px;border-radius:999px;background:var(--accent);color:white;text-decoration:none;font-weight:800}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    '<div class="eyebrow">Roundtable output</div>',
    `<h1>${escapeHtml(headline)}</h1>`,
    `<p>${escapeHtml(subhead)}</p>`,
    '<a class="cta" href="mailto:hello@example.com">开始联系</a>',
    '</header>',
    '<section class="grid">',
    ...sections.map(([heading, body]) => `<article class="card"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(body)}</p></article>`),
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function checkoutFlowHtml(title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light;--ink:#172033;--muted:#667085;--line:#d8e0ea;--panel:#ffffff;--bg:#f5f7fb;--accent:#2563eb;--ok:#12b76a;--warn:#f79009}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'main{max-width:1180px;margin:0 auto;padding:34px 24px 54px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}h1{font-size:34px;line-height:1.08;margin:5px 0 0}.secure{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;background:white;padding:8px 12px;color:var(--muted);font-size:13px}',
    '.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 50px -35px rgba(18,31,56,.38)}.section{padding:18px;border-bottom:1px solid var(--line)}.section:last-child{border-bottom:0}.section h2{font-size:15px;margin:0 0 12px}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}.step{border:1px solid var(--line);background:#f8fafc;border-radius:10px;padding:10px}.step b{display:block;font-size:12px}.step span{display:block;color:var(--muted);font-size:11px;margin-top:2px}.step.active{border-color:var(--accent);background:#eff6ff;color:var(--accent)}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field label{font-size:12px;font-weight:700;color:#344054}.field input,.field select{height:42px;border:1px solid var(--line);border-radius:9px;padding:0 11px;font:inherit;background:#fff}.error{border-color:#f04438!important;background:#fff8f7!important}.hint{font-size:12px;color:#f04438}.paybox{display:grid;gap:10px}.method{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:12px}.method.active{border-color:var(--accent);background:#eff6ff}.badge{font-size:11px;font-weight:800;color:var(--ok);background:#ecfdf3;border-radius:999px;padding:3px 8px}.summary{padding:18px;position:sticky;top:18px}.item,.row{display:flex;justify-content:space-between;gap:12px}.item{padding:12px 0;border-bottom:1px solid var(--line)}.item strong{font-size:13px}.item span,.row span{color:var(--muted);font-size:13px}.row{padding:8px 0}.total{font-size:18px;font-weight:850;color:var(--ink)}.cta{width:100%;height:46px;margin-top:14px;border:0;border-radius:11px;background:var(--accent);color:white;font:inherit;font-weight:850;cursor:pointer}.confirm{display:grid;gap:8px;border:1px solid #abefc6;background:#ecfdf3;color:#067647;border-radius:12px;padding:13px;margin-top:12px}.confirm b{font-size:14px}.confirm span{font-size:12px;color:#067647}@media(max-width:860px){.layout{grid-template-columns:1fr}.summary{position:static}.steps{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<div class="top"><div><div class="eyebrow">Checkout flow delivery</div><h1>Cart to confirmation checkout</h1></div><div class="secure">Lock icon Secure payment handoff</div></div>',
    '<div class="steps"><div class="step active"><b>1. Cart</b><span>Review order</span></div><div class="step active"><b>2. Details</b><span>Validate inputs</span></div><div class="step active"><b>3. Payment</b><span>Provider handoff</span></div><div class="step"><b>4. Confirmation</b><span>Receipt state</span></div></div>',
    '<div class="layout">',
    '<section class="panel">',
    '<div class="section"><h2>Customer details</h2><div class="grid"><div class="field"><label>Email</label><input value="alex@example.com" /></div><div class="field"><label>Phone</label><input value="+1 415 555 0148" /></div><div class="field"><label>Country</label><select><option>United States</option></select></div><div class="field"><label>ZIP code</label><input class="error" value="94" /><div class="hint">ZIP must be 5 digits before payment handoff.</div></div></div></div>',
    '<div class="section"><h2>Payment handoff</h2><div class="paybox"><div class="method active"><div><strong>Card via Stripe</strong><div class="hint" style="color:var(--muted)">Tokenize card, then create payment intent server-side.</div></div><span class="badge">selected</span></div><div class="method"><div><strong>Wallet</strong><div class="hint" style="color:var(--muted)">Apple Pay / Google Pay when available.</div></div><span>optional</span></div></div></div>',
    '<div class="section"><h2>Post-payment confirmation</h2><div class="confirm"><b>Payment authorized. Order RT-1048 ready.</b><span>Show this state after webhook confirmation and persist receipt details.</span></div></div>',
    '</section>',
    '<aside class="panel summary"><h2>Cart summary</h2><div class="item"><div><strong>Growth plan</strong><br><span>Annual subscription</span></div><strong>$240</strong></div><div class="item"><div><strong>Priority support</strong><br><span>Monthly add-on</span></div><strong>$29</strong></div><div class="row"><span>Subtotal</span><strong>$269</strong></div><div class="row"><span>Tax estimate</span><strong>$21.52</strong></div><div class="row total"><span>Total</span><strong>$290.52</strong></div><button class="cta">Continue to payment</button><div class="confirm"><b>Acceptance criteria covered</b><span>Cart summary, validation, payment handoff, and confirmation state are all represented.</span></div></aside>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function userGoalTitle(message: string): string {
  const trimmed = message.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}...` : trimmed || 'Roundtable deliverable';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function commandForAgent(agent: AgentProfile): string {
  return process.env[`ROUNDTABLE_AGENT_COMMAND_${envKey(agent.id)}`]
    || process.env[`ROUNDTABLE_AGENT_COMMAND_${envKey(agent.role)}`]
    || process.env.ROUNDTABLE_AGENT_COMMAND
    || defaultCommandForAgent(agent);
}

function defaultCommandForAgent(agent: AgentProfile): string {
  if (agent.role === 'reviewer' && process.env.ROUNDTABLE_REVIEWER_PREFERS_OPENCODE === '1') return 'opencode';
  return 'claude';
}

function commandArgs(prompt: string, agent: AgentProfile): string[] {
  const configured = splitArgs(
    process.env[`ROUNDTABLE_AGENT_ARGS_${envKey(agent.id)}`]
    || process.env[`ROUNDTABLE_AGENT_ARGS_${envKey(agent.role)}`]
    || process.env.ROUNDTABLE_AGENT_ARGS
    || '',
  );
  if (configured.length > 0) {
    if (configured.some((arg) => arg.includes('{prompt}'))) {
      return configured.map((arg) => arg.replace('{prompt}', prompt));
    }
    return [...configured, prompt];
  }
  if (commandForAgent(agent).endsWith('opencode') || commandForAgent(agent).includes('/opencode')) {
    return ['run', prompt];
  }
  return ['-p', prompt, '--permission-mode', 'bypassPermissions'];
}

// The architect's standing mandate — the same principles govern both the
// upfront design pass and the post-build architecture check.
const ARCHITECT_PRINCIPLES = [
  'Architecture principles you enforce:',
  '1. Software-engineering discipline: SOLID, separation of concerns, DRY, KISS. Prefer boring, proven patterns over clever ones.',
  '2. Modularity: small cohesive modules with clear boundaries and single responsibilities; no god-files. Organize by feature/domain.',
  '3. No hardcoding: magic numbers, inline URLs/keys, duplicated string literals, and copy-pasted logic must be routed through named constants, configuration, or shared utilities.',
  '4. Built for what comes next: design so future features extend the system instead of rewriting it — reuse existing modules wherever possible, and make the seams for extension explicit.',
].join('\n');

// Design (plan stage) and the post-build check (review stage) are different
// jobs: the first produces the blueprint the implementer follows, the second
// audits the implementation against it and gates delivery.
function architectInstruction(task: PlanTask): string {
  if ((task.stageKind ?? task.stageId) === 'review') {
    return 'Audit the implemented code against the architecture principles below. '
      + 'Verify modular structure (small cohesive files, clear boundaries), flag every hardcoded value and every piece of '
      + 'copy-pasted logic that should be extracted into a shared module, and confirm the structure supports future extension. '
      + 'Report concrete findings with severity labels (Critical/High/Medium) and file references. Do NOT rewrite the code '
      + 'yourself — a fixer applies your findings. If the architecture is solid, say so explicitly.';
  }
  return 'Design the technical architecture BEFORE any code is written: module boundaries, file/folder structure, '
    + 'data contracts and interfaces, naming conventions, and the dependency order of the work. Map which existing code '
    + 'or modules should be reused instead of rewritten. Write the architecture document to a file the implementer can '
    + 'follow directly (e.g. docs/architecture.md in the workspace), and keep it concrete: name the files to create and '
    + 'what belongs in each. Do NOT implement the product itself.';
}

function agentPrompt(
  agent: AgentProfile,
  input: { task: PlanTask; message: string; handoffContext?: string | undefined },
  extras?: { memoryBlock?: string | undefined; maintenanceBlock?: string | undefined },
): string {
  const roleInstruction = input.task.stageId === 'answer'
    ? 'Answer the user\'s question directly, using the files in this workspace as reference. '
      + 'Do NOT create, modify, or delete any files and do NOT produce a plan — reply with the answer itself in Markdown.'
    : {
        planner: 'Create the initial breakdown and routing. Do not implement unless the task explicitly asks only for planning.',
        pm: 'Clarify product intent, constraints, acceptance criteria, and sequencing.',
        architect: architectInstruction(input.task),
        implementer: 'Modify the project files needed to complete your assigned slice. '
          + 'Follow the architecture document from the previous agent output if one is provided: respect its module '
          + 'boundaries and file structure, reuse the modules it maps out, and keep values configurable instead of hardcoded.',
        reviewer: 'Review the current project state and report concrete issues, risks, and missing tests.',
        fixer: 'Apply focused fixes for known issues and summarize changed files.',
      }[agent.role];

  return [
    'You are running inside Roundtable as one CLI-backed coding agent.',
    `Agent: ${agent.displayName} (${agent.id})`,
    `Role: ${agent.role}`,
    `Instruction: ${roleInstruction}`,
    ...(agent.role === 'architect' ? [ARCHITECT_PRINCIPLES] : []),
    `Task: ${input.task.title}`,
    `Brief: ${input.task.brief}`,
    `Original user request: ${input.message}`,
    input.handoffContext
      ? `Previous agent output:\n\n${input.handoffContext}`
      : 'You are the first agent in this chain.',
    docPolicyFor(agent),
    ...(extras?.memoryBlock ? [extras.memoryBlock] : []),
    ...(extras?.maintenanceBlock ? [extras.maintenanceBlock] : []),
    'Work inside the current working directory. You may inspect and edit files as needed for this role.',
    'Do not touch files outside this working directory.',
    'When finished, print a concise Markdown summary with changed files, commands run, and any blockers.',
  ].join('\n\n');
}

// Prompt for chat-only model adapters (MiniMax): no shell, no file tools — the
// deliverable must come back IN the response text. This is deliberately
// different from agentPrompt (which targets file-editing CLIs) because a chat
// model told to "edit files" just emits shell commands it can't run.
function chatAgentPrompt(
  agent: AgentProfile,
  input: { task: PlanTask; message: string; handoffContext?: string | undefined },
): string {
  const isHtml = pathForTask(input.task).endsWith('.html');
  const roleInstruction = input.task.stageId === 'answer'
    ? 'Answer the user\'s question directly and concisely in Markdown. Do not produce a plan or a deliverable page.'
    : {
    planner: 'Map the goal into a practical next-step plan. Keep it useful and concise.',
    pm: 'Clarify product intent, constraints, acceptance criteria, and sequencing.',
    architect: (input.task.stageKind ?? input.task.stageId) === 'review'
      ? 'Audit the upstream implementation for software-engineering discipline: modularity, no hardcoded values, reusable structure. Report findings with Critical/High/Medium labels; if it is solid, say so explicitly.'
      : 'Design the architecture the implementer should follow: module boundaries, file structure, data contracts, naming, and what existing code to reuse. No hardcoded values — name the constants/config instead.',
    implementer: isHtml
      ? 'Produce a usable HTML artifact. Prefer concise, complete HTML with head and body content; choose the structure and visual approach that best fits the task.'
      : 'Produce the useful deliverable content directly. Choose Markdown, code, or structured notes as appropriate.',
    reviewer: 'Review the upstream work plainly. Call out concrete issues and risks; if it is solid, say so explicitly.',
    fixer: isHtml
      ? 'Repair the upstream HTML deliverable. Preserve what works, fix the reported problem, and return the corrected artifact.'
      : 'Apply a focused fix for the reported problem and output the corrected deliverable or a concise repair summary.',
  }[agent.role] ?? 'Produce your deliverable directly in the response.';

  return [
    'You are one specialist on the Roundtable AI team. You respond through a chat API.',
    'You do not have shell or file-system access, so put your useful output directly in the reply.',
    `You are ${agent.displayName}, the ${agent.role}.`,
    `Instruction: ${roleInstruction}`,
    `Original user request: ${input.message}`,
    // HTML replies must stay pure HTML — the memory section would corrupt the page.
    ...(isHtml
      ? []
      : [
          'If (and only if) you learned something durable — a user preference, a project fact, a pattern worth reusing — '
          + 'end your reply with a "## Memory" section containing at most 3 bullets, each formatted "- slug-name: the fact". '
          + 'It is captured into your persistent memory and stripped from the deliverable. Omit the section when nothing is worth remembering.',
        ]),
  ].join('\n\n');
}

function envKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function timeoutMs(): number | undefined {
  const parsed = Number(process.env.ROUNDTABLE_AGENT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function idleTimeoutMs(): number | undefined {
  const parsed = Number(process.env.ROUNDTABLE_AGENT_IDLE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
}

// Optional output ceiling for chat model deliverables. Unset by default: the
// provider's own limit applies, and length-cut responses are stitched back
// together by the continuation loop in runChatModelTask.
function modelMaxTokens(): number | undefined {
  const parsed = Number(process.env.ROUNDTABLE_MODEL_MAX_TOKENS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// How many "continue from where you stopped" rounds a single deliverable may
// use when the provider reports finish_reason=length (default 2).
function maxModelContinuations(): number {
  const parsed = Number(process.env.ROUNDTABLE_MODEL_MAX_CONTINUATIONS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}
