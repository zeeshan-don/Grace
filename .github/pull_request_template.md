## Summary

<!-- One or two sentences describing what this PR does. -->

## What changed?

<!--
List the concrete changes. For example:

- Added a `--dry-run` flag to `run_command`
- Fixed session rollover to start the next window only after the current one expires
-->

-

## Why?

<!-- Why is this change needed? Link any related issue or discussion. -->

## Related issue

<!-- e.g. Closes #123 — or "None" -->

## Tests performed

<!--
What did you run and what were the results? At minimum:

- [ ] `python -m pytest`
- [ ] `python -m compileall -q grace api tests`
-->

-

## Screenshots / terminal output

<!-- Required for UI/TUI changes: paste terminal output or screenshots showing
the before/after. Omit if this PR does not touch the UI. -->

-

## Breaking changes

<!-- Will existing users or the API contract break? If so, how is it
communicated/mitigated? -->

- [ ] This PR contains no breaking changes

## Security considerations

<!--
Does this PR touch authentication, provider keys, command execution,
filesystem access, database access, sessions, cost controls, prompt/tool
injection, or sandboxing? If so, describe the security impact and confirm no
secrets were added. See SECURITY.md.
-->

-

## Checklist

- [ ] Tests pass locally (`python -m pytest`)
- [ ] Compile check passes (`python -m compileall -q grace api tests`)
- [ ] New behavior has tests where appropriate
- [ ] No secrets, API keys, or credentials are committed
- [ ] Documentation updated when necessary (docs/, README.md, etc.)
- [ ] No unrelated changes bundled into this PR
- [ ] Backward compatibility considered
