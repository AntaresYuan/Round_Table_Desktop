// A real A2A v1.0 agent, built on the official SDK server pieces and served
// over node:http. The five original a2a tests all inject a fake client, which
// leaves everything the SDK actually does — card discovery, transport
// negotiation, JSON-RPC framing, SSE consumption — unexercised. This fixture
// closes that gap without adding a web-framework dependency.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AgentCard as AgentCardCodec, Role, TaskState, type AgentCard } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';

export type TestAgentOptions = {
  /** Media type stamped on the delivered artifact. */
  artifactMediaType?: string;
  /** Emit interim status messages before delivering. */
  narrate?: boolean;
  /** How many narration events to emit when `narrate` is set. */
  narrateLines?: number;
  /** Advertise the interface at this URL instead of the real one. */
  advertisedUrlOverride?: string | null;
  /**
   * Reply with a bare Message instead of a Task — the shape a synchronous
   * agent uses when it has an answer and no long-running work to track.
   */
  respondWithMessage?: boolean;
};

export type TestAgent = {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string | undefined }>;
  /** How many requests arrived carrying the given bearer token. */
  requestsWithToken: (token: string) => number;
  close: () => Promise<void>;
};

const DELIVERABLE = '# Remote deliverable\n\nProduced by the test A2A agent.\n';

class TestExecutor implements AgentExecutor {
  constructor(private readonly options: TestAgentOptions) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const taskId = ctx.taskId || randomUUID();
    const contextId = ctx.contextId || randomUUID();

    if (this.options.respondWithMessage) {
      bus.publish(AgentEvent.message({
        messageId: randomUUID(),
        contextId,
        taskId: '',
        role: Role.ROLE_AGENT,
        // No filename: the message itself is the answer.
        parts: [{
          content: { $case: 'text', value: DELIVERABLE },
          filename: '',
          mediaType: 'text/markdown',
          metadata: undefined,
        }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      } as never));
      bus.finished();
      return;
    }

    bus.publish(AgentEvent.task({
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined,
    } as never));

    if (this.options.narrate) {
      const count = this.options.narrateLines ?? 2;
      const lines = count === 2
        ? ['Reading the handoff…', 'Drafting the deliverable…']
        : Array.from({ length: count }, (_, i) => `Working, step ${i + 1}…`);
      for (const line of lines) {
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          final: false,
          metadata: undefined,
          status: {
            state: TaskState.TASK_STATE_WORKING,
            timestamp: undefined,
            message: {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: Role.ROLE_AGENT,
              parts: [{
                content: { $case: 'text', value: line },
                filename: '',
                mediaType: 'text/plain',
                metadata: undefined,
              }],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            },
          },
        } as never));
      }
    }

    bus.publish(AgentEvent.artifactUpdate({
      taskId,
      contextId,
      append: false,
      lastChunk: true,
      metadata: undefined,
      artifact: {
        artifactId: 'artifact-1',
        name: 'result.md',
        description: '',
        metadata: undefined,
        extensions: [],
        parts: [{
          content: { $case: 'text', value: DELIVERABLE },
          filename: 'result.md',
          mediaType: this.options.artifactMediaType ?? 'text/markdown',
          metadata: undefined,
        }],
      },
    } as never));

    bus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId,
      final: true,
      metadata: undefined,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
    } as never));
    bus.finished();
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: '',
      final: true,
      metadata: undefined,
      status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: undefined },
    } as never));
    bus.finished();
  }
}

export const TEST_AGENT_DELIVERABLE = DELIVERABLE;

export async function startTestA2AAgent(options: TestAgentOptions = {}): Promise<TestAgent> {
  const requests: TestAgent['requests'] = [];
  // Card and transport need the listening port, so they are filled in after
  // the server binds. A holder keeps both bindings const.
  const wired: { card: AgentCard | null; transport: JsonRpcTransportHandler | null } = {
    card: null, transport: null,
  };

  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      path: (req.url ?? '').split('?')[0] ?? '',
      authorization: req.headers.authorization,
    });

    if (req.method === 'GET' && (req.url ?? '').startsWith('/.well-known/agent-card.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(AgentCardCodec.toJSON(wired.card!)));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const context = new ServerCallContext({ requestedVersion: '1.0' });
          const outcome = await wired.transport!.handle(body, context);
          if (outcome && typeof (outcome as AsyncGenerator<unknown>)[Symbol.asyncIterator] === 'function') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            for await (const event of outcome as AsyncGenerator<unknown>) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(outcome));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  wired.card = {
    name: 'Test Remote Agent',
    description: 'A2A v1.0 agent used by the Roundtable adapter tests',
    version: '1.0.0',
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [],
    } as never,
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'text/markdown'],
    skills: [{
      id: 'demo', name: 'demo', description: 'demo',
      tags: [], examples: [], inputModes: [], outputModes: [], security: [],
    } as never],
    signatures: [],
    supportedInterfaces: [{
      url: options.advertisedUrlOverride ?? url,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: '1.0',
    }],
  };

  wired.transport = new JsonRpcTransportHandler(
    new DefaultRequestHandler(wired.card, new InMemoryTaskStore(), new TestExecutor(options)),
  );

  return {
    url,
    requests,
    requestsWithToken: (token) => requests.filter((r) => r.authorization?.includes(token)).length,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** A socket that accepts connections and never answers. */
export async function startBlackHole(): Promise<{ url: string; close: () => void }> {
  const { createServer: createTcpServer } = await import('node:net');
  const server = createTcpServer((socket) => { socket.on('data', () => {}); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
