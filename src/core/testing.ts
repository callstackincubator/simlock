/**
 * Test-only: fakes and test wiring other modules' tests use. Only a `*.test.ts` file or a
 * `test-*.ts` helper may import this file, and `pnpm lint` enforces it. Anything production code
 * also uses belongs on `index.ts`.
 */
export { capacityChangedPayload } from "./capacity/testing.js";
export type { FakeDriverOptions } from "./fake-driver.js";
export { testComponentWiring } from "./test-wiring.js";
