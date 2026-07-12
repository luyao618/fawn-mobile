import assert from "node:assert/strict";
import test from "node:test";

import { redactOutput } from "../../../tools/redaction.mjs";

test("Slice 0 command output redacts credentials and private keys", () => {
  const input = [
    "Authorization: Bearer sk-synthetic-secret",
    "api_key=synthetic-key token: synthetic-token password=hunter2",
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
  ].join("\n");
  const output = redactOutput(input);
  for (const secret of ["sk-synthetic-secret", "synthetic-key", "synthetic-token", "hunter2", "PRIVATE KEY-----\nsynthetic"]) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /\[REDACTED\]/);
});

