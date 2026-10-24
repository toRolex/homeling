# Public origin raw syntax repair

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

Pending the guard and reruns. No lockfile or dependency modifications are authorized. No browser, deployment, Serve, plist, Collie, runtime service, gh, private API or secret operations are authorized.

## Deviations

No child exploration or independent review runs in this worker because subdelegation is forbidden. The parent owns the fresh independent review. No README or deployment documentation edits.
