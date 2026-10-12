# Pilot digest size

The pilot supports at most 20 papers per digest. A user's smaller preferred count is preserved; this is a ceiling, not a minimum. The candidate search pool is not capped at 20.

The shared limit is enforced when choosing papers, reading a resumed scheduled digest, adding browser papers, selecting coverage replacements, and immediately before triage. Additions share the same allowance. A full browser digest refuses extra reads without re-ranking. An already saved digest with more than 20 processed papers is preserved, but cannot be resumed into an oversized paid request. Overflow candidates are not marked seen solely because the digest reached its limit.

The checker receives enough output allowance for up to 40 findings/cautions (5,120 tokens at full capacity). Smaller requests retain the 2,048-token minimum. Existing spending policies and reservations still apply.

Validation: deterministic tests exercise a full 20-paper writer/checker flow, browser fresh/addition boundaries, scheduler resume/fallback limits, old preferences and rejection before paid dispatch. These tests use fake model responses. Release still requires one authorized full 20-paper real-model/hosted acceptance run to measure completion time, verdict completeness and cost. No actual runtime maximum is inferred from mocked tests.

The larger-digest split/streaming designs remain deferred during the pilot; no streaming or new retry path is enabled. This limit does not authorize release or additional model spending.
