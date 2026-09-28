import type { AgentCard, AgentRole, ArtifactKind } from '../types.js';

export type AgentProfile = {
  id: string;
  role: AgentRole;
  assignee: string;
  displayName: string;
  aliases: string[];
  capabilities: string[];
  skills: string[];
  preferredTaskTypes: string[];
  supportedArtifactTypes: ArtifactKind[];
  safetyConstraints: string[];
};

export const AGENT_ROSTER: AgentProfile[] = [
  {
    id: 'orchestrator',
    role: 'planner',
    assignee: '@planning',
    displayName: 'Planning',
    aliases: ['planning', 'planner', 'orchestrator', 'all'],
    capabilities: ['mission.planning', 'workflow.decomposition', 'handoff.context_packaging'],
    skills: ['clarify_requirements', 'split_tasks', 'sequence_dependencies'],
    preferredTaskTypes: ['plan', 'clarify', 'handoff'],
    supportedArtifactTypes: ['markdown', 'code', 'spec'],
    safetyConstraints: ['ask_before_dispatch', 'summarize_context_only'],
  },
  {
    id: 'mira',
    role: 'pm',
    assignee: '@pm',
    displayName: 'PM',
    aliases: ['pm', 'product', 'manager'],
    capabilities: ['product.briefing', 'requirements.coverage', 'novice.copy'],
    skills: ['write_brief', 'define_acceptance_criteria', 'surface_tradeoffs'],
    preferredTaskTypes: ['brief', 'requirements', 'checkpoint'],
    supportedArtifactTypes: ['markdown', 'spec'],
    safetyConstraints: ['call_out_assumptions', 'avoid_hidden_scope_growth'],
  },
  {
    id: 'nova',
    role: 'architect',
    assignee: '@nova',
    displayName: 'Nova',
    aliases: ['nova', 'architect', 'architecture'],
    capabilities: ['system.design', 'dependency.mapping', 'technical.plan', 'architecture.review', 'code.modularity'],
    skills: ['architecture_map', 'contract_design', 'risk_modeling', 'modular_decomposition', 'reuse_mapping', 'hardcode_detection'],
    preferredTaskTypes: ['architecture', 'design', 'research', 'architecture_review'],
    supportedArtifactTypes: ['markdown', 'code', 'spec'],
    safetyConstraints: ['prefer_existing_patterns', 'note_integration_risks', 'no_hardcoded_values', 'reuse_over_rewrite'],
  },
  {
    id: 'atlas',
    role: 'implementer',
    assignee: '@atlas',
    displayName: 'Atlas',
    aliases: ['atlas', 'implementer', 'frontend', 'dev'],
    capabilities: ['frontend.implementation', 'ui.integration', 'artifact.preview'],
    skills: ['react_ui', 'css_systems', 'component_integration'],
    preferredTaskTypes: ['frontend', 'ui', 'preview'],
    supportedArtifactTypes: ['code', 'html', 'preview', 'diff'],
    safetyConstraints: ['preserve_design_system', 'avoid_fixture_only_outputs'],
  },
  {
    id: 'beam',
    role: 'implementer',
    assignee: '@beam',
    displayName: 'Beam',
    aliases: ['beam', 'backend', 'api'],
    capabilities: ['backend.implementation', 'api.integration', 'data.persistence'],
    skills: ['server_actions', 'api_routes', 'schema_validation'],
    preferredTaskTypes: ['backend', 'api', 'database'],
    supportedArtifactTypes: ['code', 'markdown', 'spec'],
    safetyConstraints: ['validate_inputs', 'avoid_secret_exposure'],
  },
  {
    id: 'vera',
    role: 'reviewer',
    assignee: '@vera',
    displayName: 'Vera',
    aliases: ['vera', 'reviewer', 'review'],
    capabilities: ['review.quality_gate', 'risk.assessment', 'test_evidence'],
    skills: ['code_review', 'requirements_trace', 'confidence_report'],
    preferredTaskTypes: ['review', 'qa', 'final_report'],
    supportedArtifactTypes: ['markdown', 'diff', 'spec'],
    safetyConstraints: ['block_high_risk_findings', 'state_test_gaps'],
  },
  {
    id: 'fixer',
    role: 'fixer',
    assignee: '@fixer',
    displayName: 'Fixer',
    aliases: ['fixer', 'fix', 'debugger'],
    capabilities: ['repair.implementation', 'test_failure_repair', 'focused_changes'],
    skills: ['debug_failures', 'apply_review_fixes', 'summarize_repairs'],
    preferredTaskTypes: ['repair', 'fix', 'debug'],
    supportedArtifactTypes: ['code', 'diff', 'markdown'],
    safetyConstraints: ['fix_only_reported_scope', 'preserve_working_outputs'],
  },
];

export function agentCardFor(profile: AgentProfile): AgentCard {
  return {
    id: profile.id,
    name: profile.displayName,
    role: profile.role,
    capabilities: [...profile.capabilities],
    skills: [...profile.skills],
    preferredTaskTypes: [...profile.preferredTaskTypes],
    supportedArtifactTypes: [...profile.supportedArtifactTypes],
    adapterMetadata: { assignee: profile.assignee },
    safetyConstraints: [...profile.safetyConstraints],
  };
}

export function resolveAgentMention(value: string): AgentProfile | null {
  const normalized = value.replace(/^@/, '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  return AGENT_ROSTER.find((agent) =>
    agent.id === normalized
    || agent.role === normalized
    || agent.aliases.includes(normalized),
  ) ?? null;
}

export function agentForTask(input: {
  owner?: string | undefined;
  assignee: string;
  role?: string | undefined;
  requiredCapabilities?: string[] | undefined;
}): AgentProfile {
  const byOwner = input.owner ? resolveAgentMention(input.owner) : null;
  if (byOwner) return byOwner;
  const byAssignee = resolveAgentMention(input.assignee);
  if (byAssignee) return byAssignee;
  const byRole = input.role ? resolveAgentMention(input.role) : null;
  if (byRole) return byRole;
  const required = input.requiredCapabilities ?? [];
  if (required.length > 0) {
    const byCapabilities = AGENT_ROSTER.find((agent) =>
      required.every((capability) => agent.capabilities.includes(capability)),
    );
    if (byCapabilities) return byCapabilities;
  }
  return AGENT_ROSTER[0]!;
}

export function mentionTokens(message: string): string[] {
  return [...message.matchAll(/@([a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? '');
}

export function messageWithoutMentions(message: string): string {
  return message.replace(/@([a-zA-Z][\w-]*)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function mentionedAgents(message: string): AgentProfile[] {
  const tokens = mentionTokens(message);
  if (tokens.length === 0 || tokens.some((token) => token.toLowerCase() === 'all')) {
    return [...AGENT_ROSTER];
  }

  const seen = new Set<string>();
  const agents: AgentProfile[] = [];
  for (const token of tokens) {
    const target = resolveAgentMention(token);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    agents.push(target);
  }
  return agents.length > 0 ? agents : [...AGENT_ROSTER];
}
