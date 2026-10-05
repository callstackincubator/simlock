/** Test-only: what other modules' tests read from the capacity component. Only a `*.test.ts` file
 * or a `test-*.ts` helper may import this file, and `pnpm lint` enforces it. */
export { resourceStrategy } from "./strategies/resource/index.js";
