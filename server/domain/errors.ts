export class DomainError extends Error {
  constructor(public code: string, public status: number, message?: string, public action?: Record<string, unknown>, public fields?: { path: string; code: string }[]) { super(message ?? code); }
}
