/**
 * Sent as `collectorVersion` on every metrics batch, so a support
 * conversation about a wrong-looking chart can start from "which agent build
 * reported this" instead of a guess.
 *
 * Not read from `package.json`: this package has no JSON import today, and
 * `wire-contract.test.ts` pins its dependency list and import shape exactly
 * because a customer's security reviewer is expected to read it. The release
 * pull request sets this, `package.json`'s `version` and agent-go's
 * `agentRelease` to each new version (release-please-config.json).
 */
export const AGENT_VERSION = "0.5.3"; // x-release-please-version

/**
 * What this build can do beyond the four probe verbs, declared on every poll
 * (`AgentSelfReport`). A capability is a promise about how this agent treats
 * a field, and the server withholds that field's content from any agent that
 * did not declare it.
 *
 *   secret_refs   `auth` on an http check: `${SECRET:NAME}` references in
 *                 request headers and URL credentials, resolved on this
 *                 machine (secrets.ts). Since 0.4.0.
 *
 * Pinned to the server's own list by wire-contract.test.ts.
 */
export const AGENT_CAPABILITIES = ["secret_refs"] as const;
