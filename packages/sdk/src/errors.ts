export class SdkError extends Error {
  public code: string;
  constructor(message: string, code: string = 'UNKNOWN_ERROR') {
    super(message);
    this.name = 'SdkError';
    this.code = code;
  }
}

export class ContractError extends SdkError {
  constructor(message: string) {
    super(message, 'CONTRACT_ERROR');
    this.name = 'ContractError';
  }
}

export class NetworkError extends SdkError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}

export function normalizeError(err: unknown): SdkError {
  if (err instanceof SdkError) {
    return err;
  }
  if (err instanceof Error) {
    return new SdkError(err.message, 'INTERNAL_ERROR');
  }
  return new SdkError(String(err), 'UNKNOWN_ERROR');
}
