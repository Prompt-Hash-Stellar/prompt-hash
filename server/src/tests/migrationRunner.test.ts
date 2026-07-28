import { runMigrations } from "../db/migrationRunner";
import { MigrationModel } from "../models/Migration";
import { MIGRATIONS } from "../db/migrations/registry";

// 1. Mock DB connection
jest.mock("../db/connectDb", () => {
  const mockDb = {
    collection: jest.fn().mockReturnValue({
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }),
  };
  const mockConnection = {
    connection: {
      db: mockDb,
    },
  };
  return jest.fn().mockResolvedValue(mockConnection);
});

// 2. Mock Migration model
jest.mock("../models/Migration", () => {
  const mockFind = jest.fn();
  const mockChain = {
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  mockFind.mockReturnValue(mockChain);

  return {
    MigrationModel: {
      find: mockFind,
      findOne: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
      __chain: mockChain,
    },
  };
});

// 3. Mock migrations registry with self-contained mock functions
jest.mock("../db/migrations/registry", () => {
  return {
    MIGRATIONS: [
      {
        version: 1,
        name: "migration_one",
        up: jest.fn().mockImplementation(() => Promise.resolve()),
        down: jest.fn().mockImplementation(() => Promise.resolve()),
      },
      {
        version: 2,
        name: "migration_two",
        up: jest.fn().mockImplementation(() => Promise.resolve()),
        down: jest.fn().mockImplementation(() => Promise.resolve()),
      },
    ],
  };
});

describe("Migration Runner", () => {
  const mockFind = MigrationModel.find as jest.Mock;
  const mockFindOne = MigrationModel.findOne as jest.Mock;
  const mockCreate = MigrationModel.create as jest.Mock;
  const mockDeleteOne = MigrationModel.deleteOne as jest.Mock;
  const mockChain = (MigrationModel as any).__chain;

  const [migrationOne, migrationTwo] = MIGRATIONS;
  const mockUp1 = migrationOne.up as jest.Mock;
  const mockDown1 = migrationOne.down as jest.Mock;
  const mockUp2 = migrationTwo.up as jest.Mock;
  const mockDown2 = migrationTwo.down as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockReturnValue(mockChain);
    mockChain.sort.mockReturnThis();
    mockChain.exec.mockResolvedValue([]);
    mockUp1.mockReset().mockResolvedValue(undefined);
    mockDown1.mockReset().mockResolvedValue(undefined);
    mockUp2.mockReset().mockResolvedValue(undefined);
    mockDown2.mockReset().mockResolvedValue(undefined);
  });

  it("should run all migrations on a fresh database", async () => {
    // DB has no migrations applied
    mockChain.exec.mockResolvedValueOnce([]);

    await runMigrations("up");

    // Both migrations should be executed
    expect(mockUp1).toHaveBeenCalledTimes(1);
    expect(mockUp2).toHaveBeenCalledTimes(1);

    // Records created in database
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ version: 1, name: "migration_one" }));
    expect(mockCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ version: 2, name: "migration_two" }));
  });

  it("should run only pending migrations on an existing database", async () => {
    // Migration 1 is already applied, migration 2 is pending
    mockChain.exec.mockResolvedValueOnce([
      { version: 1, name: "migration_one", appliedAt: new Date() },
    ]);

    await runMigrations("up");

    // Only migration 2 should be executed
    expect(mockUp1).not.toHaveBeenCalled();
    expect(mockUp2).toHaveBeenCalledTimes(1);

    // Record created only for migration 2
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ version: 2, name: "migration_two" }));
  });

  it("should stop execution and throw if a migration fails", async () => {
    // Migration 1 throws an error
    mockUp1.mockRejectedValueOnce(new Error("Migration failed"));
    mockChain.exec.mockResolvedValueOnce([]);

    await expect(runMigrations("up")).rejects.toThrow("Migration failed");

    // Migration 2 should not start, and only migration 1 was called
    expect(mockUp1).toHaveBeenCalledTimes(1);
    expect(mockUp2).not.toHaveBeenCalled();

    // No migration record created
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should rollback the last applied migration", async () => {
    const mockFindOneChain = {
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ version: 2, name: "migration_two" }),
    };
    mockFindOne.mockReturnValue(mockFindOneChain);

    await runMigrations("down");

    // down function of version 2 must be called, version 1 remains untouched
    expect(mockDown2).toHaveBeenCalledTimes(1);
    expect(mockDown1).not.toHaveBeenCalled();

    // Record deleted from DB
    expect(mockDeleteOne).toHaveBeenCalledTimes(1);
    expect(mockDeleteOne).toHaveBeenCalledWith({ version: 2 });
  });

  it("should do nothing if there are no migrations to rollback", async () => {
    const mockFindOneChain = {
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };
    mockFindOne.mockReturnValue(mockFindOneChain);

    await runMigrations("down");

    expect(mockDown1).not.toHaveBeenCalled();
    expect(mockDown2).not.toHaveBeenCalled();
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });
});
