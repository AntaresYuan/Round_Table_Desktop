// Adapter error classes live here rather than in the adapter so that
// configuration resolution can raise them without importing the adapter
// (which imports config in turn). `dispatch.ts` keys its visible
// fall-back-to-local-dispatch behaviour off these two types: anything a
// remote endpoint can cause MUST be one of them, or the whole turn fails.

export class A2AUnavailableError extends Error {
  readonly code = 'a2a_unavailable';
  constructor(message = 'a2a_unavailable') {
    super(message);
    this.name = 'A2AUnavailableError';
  }
}

export class A2ARequestError extends Error {
  readonly code = 'a2a_request_failed';
  constructor(message: string) {
    super(message);
    this.name = 'A2ARequestError';
  }
}
