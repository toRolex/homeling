# Public origin raw syntax repair

## Status

- Raw syntax regression and guard are done. config.test.ts and config.ts have 35 passing targeted tests. The parent owns independent review.
- Full validation is done. All 555 tests, all workspace typechecks and the web build pass. Logs are listed below.
- Narrow delivery is ready for parent acceptance. The failing-test commit is b565a5b. Final diff review found only the three authorized files. git diff --check passes. No code comments were added.
- Browser and deployment acceptance remain unverified and outside this unit.

## Scope and entry

Direct execution as the authorized implementation worker. No subdelegation. Base a65f604 in t3/repair-public-origin-ui. Only config.ts, config.test.ts and this note may change. Budget is eight minutes and 20% context. Read the complete round-2 review, crossjudge contract and implementation report.

Runtime confirms PI_PROVIDER=cliproxy, PI_MODEL=gpt-6.1-sol and PI_REASONING_LEVEL=high. Model availability permits Sol for this assigned bug fix.

## Plan and checkpoint

1. Reproduce through daemonConfigFromEnv with cheap failing tests.
2. Confirm that URL normalization erases raw syntax before validation.
3. Add a raw HTTPS authority guard before new URL. Keep one canonical publicOrigin string.
4. Rerun the same tests, the full suite, typecheck and build.
5. Commit the failing tests before the fix, then inspect the narrow final diff.
6. Skip opening a PR because gh and publication are outside this unit.

The first run reports 11 pass, 21 fail and 60 assertions across 32 tests. Evidence is /tmp/homeling-ui-config-r3-red.log. One added invalid-path test already rejects correctly. The other 21 inputs demonstrate the missing raw syntax boundary. Throughput checkpoint permits the remaining guard and local validation within the budget.

## Decisions

Keep empty unset configuration compatible with local startup and default HTTPS 443 derivation. Nonempty explicit input must not be trimmed or repaired. Reject empty query and fragment markers, dot paths, userinfo, backslashes, whitespace, controls, missing authority separators and empty ports. URL remains responsible for semantic hostname, protocol and port validation. Uppercase HTTPS and hostname, default 443 and optional root slash remain valid.

This is a configuration-contract defect, not a demonstrated authentication exploit. Do not change inherited request Origin parsing or other configuration parsers.

## Verification

The guard validates the untrimmed input before URL parsing. Its absolute-end assertion prevents JavaScript's end-of-line anchor from accepting a trailing newline. Its authority cannot end with a colon, so an empty port cannot be repaired away. URL still performs semantic validation.

- Before the fix, bun test apps/daemon/src/config.test.ts reports 11 pass, 21 fail and 60 assertions. Log /tmp/homeling-ui-config-r3-red.log.
- After the fix, bun test apps/daemon/src/config.test.ts apps/daemon/src/session-routes.test.ts reports 35 pass, 0 fail and 291 assertions. Log /tmp/homeling-ui-config-r3-targeted.log.
- bun test reports 555 pass, 0 fail and 6855 assertions across 92 files. Log /tmp/homeling-ui-config-r3-full.log.
- bun run typecheck exits 0 for contracts, daemon and web. Log /tmp/homeling-ui-config-r3-typecheck.log.
- bun run build exits 0. Log /tmp/homeling-ui-config-r3-build.log.

No lockfile or dependency changes. No browser, deployment, Serve, plist, Collie, runtime service, gh, private API or secret operations ran. Model the Domain kept one canonical string without derived state. Test Behavior, Not Implementation selected direct configuration calls with literal expected origins and thrown configuration errors. Prove It Works required rerunning actual tests and the build rather than reusing earlier validation claims.

## Deviations

No child exploration or independent review runs in this worker because subdelegation is forbidden. The parent owns the fresh independent review. No README or deployment documentation edits.
