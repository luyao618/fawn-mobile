import assert from "node:assert/strict";
import test from "node:test";

import { DataMutationBusyError, DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";

test("maintenance closes admission before its first await and releases after failure", async () => {
  const coordinator = new DataMutationCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const maintenance = coordinator.runMaintenance("backup", async () => {
    await gate;
    throw new Error("maintenance failed");
  });
  assert.deepEqual(coordinator.state(), { mode: "maintenance-pending", activeUserWrites: 0, waitingMaintenance: 1 });
  await assert.rejects(coordinator.runUserWrite(async () => undefined), DataMutationBusyError);
  await assert.rejects(coordinator.runMaintenance("restore", async () => undefined), DataMutationBusyError);
  release();
  await assert.rejects(maintenance, /maintenance failed/);
  assert.deepEqual(coordinator.state(), { mode: "user-writes", activeUserWrites: 0, waitingMaintenance: 0 });
});

test("maintenance rejects async reentry after await without self-deadlocking", async () => {
  const coordinator = new DataMutationCoordinator();
  await coordinator.runMaintenance("migration", async () => {
    await Promise.resolve();
    await assert.rejects(coordinator.runMaintenance("album", async () => undefined), /admission is busy/);
    await assert.rejects(coordinator.runUserWrite(async () => undefined), /paused for maintenance/);
  });
});

test("user-write escalation fails fast after await", async () => {
  const coordinator = new DataMutationCoordinator(5);
  await coordinator.runUserWrite(async () => {
    await Promise.resolve();
    await assert.rejects(coordinator.runMaintenance("backup", async () => undefined), /admission is busy/);
  });
  await coordinator.runMaintenance("backup", async () => undefined);
});

test("concurrent independent maintenance has deterministic fail-fast admission", async () => {
  const coordinator = new DataMutationCoordinator();
  const order: string[] = [];
  const first = coordinator.runMaintenance("backup", async () => { order.push("first"); });
  const second = coordinator.runMaintenance("restore", async () => { order.push("second"); });
  await assert.rejects(second, DataMutationBusyError);
  await first;
  await coordinator.runMaintenance("restore", async () => { order.push("second-after"); });
  assert.deepEqual(order, ["first", "second-after"]);
});

test("maintenance drains active writes without overlap and rejects new writes while pending", async () => {
  const coordinator = new DataMutationCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writeActive = false;
  const first = coordinator.runUserWrite(async () => {
    writeActive = true;
    await gate;
    writeActive = false;
  });
  const maintenance = coordinator.runMaintenance("backup", async () => {
    assert.equal(writeActive, false);
    assert.equal(coordinator.state().activeUserWrites, 0);
  });
  assert.deepEqual(coordinator.state(), { mode: "maintenance-pending", activeUserWrites: 1, waitingMaintenance: 1 });
  await assert.rejects(coordinator.runUserWrite(async () => undefined), DataMutationBusyError);
  release();
  await Promise.all([first, maintenance]);
  assert.deepEqual(coordinator.state(), { mode: "user-writes", activeUserWrites: 0, waitingMaintenance: 0 });
});

test("bounded maintenance drain timeout reopens admission", async () => {
  const coordinator = new DataMutationCoordinator(5);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const write = coordinator.runUserWrite(async () => gate);
  await assert.rejects(coordinator.runMaintenance("restore", async () => undefined), DataMutationBusyError);
  assert.deepEqual(coordinator.state(), { mode: "user-writes", activeUserWrites: 1, waitingMaintenance: 0 });
  assert.equal(await coordinator.runUserWrite(async () => "recovered"), "recovered");
  release();
  await write;
});
