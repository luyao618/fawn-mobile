# Fawn Mobile Delivery Rules

These rules apply to every app slice and all future sessions and agents.

## Durable checkpoints

- Treat a PR merged into `main` as the normal durable checkpoint. Local commits and open PRs are not completed delivery.
- Before implementation, split work at the smallest independently useful and reviewable boundary that can keep `main` green.
- Do not strand completed independent work behind slow device or external blockers. Extract and merge it separately when contracts are complete and `main` remains safe.

## Delivery sequence

1. Fetch the remote and branch from the latest `origin/main`.
2. Use the `luyao618` GitHub identity and SSH-sign every Lore commit.
3. Run targeted tests for the change and the applicable shared test gates.
4. Push and open the PR promptly.
5. Merge as soon as required checks for the exact PR head and review are clean.
6. Confirm the merged commits show **Verified** on GitHub, then fast-forward local `main` before starting dependent work.

## Merge safety

- Never merge red CI, incomplete migrations or contracts, weakened gates, secrets, or raw or derived WHO rows.
- When a blocker prevents a safe merge, push the signed commits to the remote PR and record the blocker there.
