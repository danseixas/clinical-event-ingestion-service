import {
  MongoClientClosedError,
  MongoError,
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
  MongoWriteConcernError,
} from 'mongodb';

export function isDuplicateIdempotencyKey(error: unknown): boolean {
  if (!(error instanceof MongoServerError) || error.code !== 11000) {
    return false;
  }
  return (
    (error.keyPattern !== undefined && 'idempotencyKey' in error.keyPattern) ||
    (error.keyValue !== undefined && 'idempotencyKey' in error.keyValue)
  );
}

/** Errors that mean "the store cannot confirm durability now" (spec D-11). */
export function isStoreUnavailable(error: unknown): boolean {
  if (
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNetworkError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoTopologyClosedError ||
    error instanceof MongoClientClosedError ||
    error instanceof MongoWriteConcernError
  ) {
    return true;
  }
  return (
    error instanceof MongoError &&
    (error.hasErrorLabel('RetryableWriteError') ||
      error.hasErrorLabel('TransientTransactionError'))
  );
}
