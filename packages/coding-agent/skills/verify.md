---
name: verify
description: Verify a fix, implementation, performance claim or deployment against the user's actual acceptance criteria before reporting completion.
---

Identify the requested outcome, target environment and artifact. Distinguish the host, container, guest image, remote machine, source checkout and installed executable. Reuse existing results when asked to retrieve them; do not replace retrieval with a new benchmark.

Reproduce the reported path and add a regression check that would catch the original failure. Choose the smallest representative test, then expand to the authorized scope. A build, mock, handshake or adjacent protocol does not establish the full user journey. If the requested integration is unavailable, report the blocker rather than silently substituting another one.

Run checks in isolated environments without changing the user's active desktop, credentials or application state. Keep one-run test settings out of production defaults. Inspect baseline failures and distinguish implementation, harness, dependency and service faults. Do not weaken validation, hide failures or add package-specific exceptions for transient outages to make a run green.

For performance work, measure the requested metric with equivalent workloads and configuration. Separate throughput from latency and presentation rate, and RSS from PSS and private memory. Profile the bottleneck before proposing a code change.

When installation or deployment is authorized, verify the exact launcher and artifact the user will run. Check commands against the user's shell; use `env NAME=value command` rather than Bash-only assignments in Fish examples. Recheck enabled features after changing a profile or launch flag. Publish only when authorized, and verify the consumer-facing artifact after publication.

Track background runs by job ID. Distinguish running, failed, cancelled and superseded attempts. A late notification from an earlier failed attempt does not invalidate a successful rerun; do not repeat finished-task replies for redundant events.

Before reporting, check the current diff and final test result. State what changed, what actually ran and the remaining limit. Keep unit, mocked integration and live end-to-end coverage distinct. Do not claim that all tests passed when the requested suite was only sampled, skipped or still running. Continue independent authorized work until the task is complete or genuinely blocked.
