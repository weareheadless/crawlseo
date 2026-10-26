# Agent task coordination

Use the [shared pickup, review and manager commands](https://github.com/weareheadless/site-agent/blob/ecf778d74123ee643ff9bf4a827bd50eb1a0f6b7/docs/agent-coordination.md).
This repo pins that one checker; it does not maintain another coordinator implementation.

Give the agent its issue URL. It records a bounded claim and an early draft PR,
uses the PR template, runs this repo's tests, and stops for manager review.
The manager checks real readiness/dependencies and current-head CI, then reviews
the actual diff before merge. Scope changes need an explicit reviewed replan.

One shared key is sufficient; run IDs distinguish cooperating agents, not
independent authenticated identities. No new service, dispatcher or credential
system is introduced. Personal keys are not added to CI. Existing release and
customer approval rules remain binding. Merged does not mean Verified.

The automatic format workflow applies to UI/OPS task markers and is active after
its PR merges. It checks the pinned shared code and never executes the task
branch. The manager command publishes Agent coordination after its live checks;
that status still does not replace code review or authorize deployment.
