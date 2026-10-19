# Local investigation workflow

The user requested a cautious, documented investigation of Vertex ECONNRESET and Gemini 4 thinking controls.

- Read VERTEX_GEMINI_INVESTIGATION_LOG.md before continuing this investigation.
- At the end of every relevant conversation turn, append or complete a dated record in that single log: user request/clarifications, approved scope, findings with evidence, actual file changes and reasons, tests/results/limits, Git state, and next step. Use Asia/Shanghai dates.
- On 2026-10-19 the user approved implementing the ECONNRESET and thinking-level fixes from the reviewed plan. Carry out this scope without repeatedly asking for the same permission; record additional findings separately instead of expanding into unrelated preset or parser changes.
- The subsequent 2026-10-19 approval also covers the section 003 follow-ups: all Google text parts, bounded optional stream diagnostics, and first-stage native Vertex PDF attachments. Preserve the stable transport and complete-tool workflow; do not enable partial tool arguments or automatically replay requests.
- Documentation and local Git tracking were explicitly requested and may proceed. Keep implementation fixes in separate focused commits, with their log updates.
- Preserve existing user data, presets, extensions, configuration, and unrelated work. Do not commit secrets, request bodies, real chat content, or private runtime artifacts.
- Do not automatically resubmit generation on network failure or tool-only/empty-looking output. The user stores response prose in tool-call arguments; preserve that workflow.
- Distinguish isolated tests, protocol connectivity probes, and actual browser/Google/TUN end-to-end evidence. Do not claim the old deleted implementation caused a fault without its source.
- Do not push any remote unless the user requests it. Prefer targeted git revert for later rollback; never destructive cleanup of user data.
