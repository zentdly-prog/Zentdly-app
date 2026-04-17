export class ZentdlyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "ZentdlyError";
  }
}

export class NotFoundError extends ZentdlyError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      "NOT_FOUND",
      404,
    );
  }
}

export class ConflictError extends ZentdlyError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}

export class ValidationError extends ZentdlyError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 422);
  }
}

export class IntegrationError extends ZentdlyError {
  constructor(provider: string, message: string) {
    super(`[${provider}] ${message}`, "INTEGRATION_ERROR", 502);
  }
}
