/**
 * Sent as `collectorVersion` on every metrics batch, so a support
 * conversation about a wrong-looking chart can start from "which agent build
 * reported this" instead of a guess.
 *
 * Not read from `package.json`: this package has no JSON import today, and
 * `wire-contract.test.ts` pins its dependency list and import shape exactly
 * because a customer's security reviewer is expected to read it. Keep this
 * in sync with the `version` field in `package.json` by hand when either
 * changes.
 */
export const AGENT_VERSION = "0.2.0";
